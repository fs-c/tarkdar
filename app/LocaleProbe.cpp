#include "app/LocaleProbe.hpp"

#include "core/mem/ReadBatch.hpp"
#include "core/text/Utf16.hpp"
#include "game/eft/Read.hpp"

#include <crow/json.h>

#include <algorithm>
#include <array>
#include <cctype>
#include <chrono>
#include <cstring>
#include <format>
#include <span>
#include <unordered_map>
#include <vector>

namespace radar::app {

namespace {

using mem::Address;
using Json = crow::json::wvalue;
using JsonList = std::vector<Json>;

// From dumps/il2cpp-dump.json, as in QuestProbe.cpp (where the table was first found).
inline constexpr std::int32_t LocalizationManagerTypeIndex = 8622;  // EFT.LocalizationManager
inline constexpr std::uint32_t LmInstance = 0x8;                     // static _instance
inline constexpr std::uint32_t LmLocales = 0x38, LmCulture = 0x70;   // _locales (lang → EFT.Locale), culture

// Keys are read up to this many UTF-16 code units (longer ones are cut: exit names are short).
constexpr std::size_t kKeyChars = 96;
constexpr std::size_t kHashSample = 400;
constexpr std::size_t kRelatedPerName = 12;
constexpr std::size_t kExitLike = 800;

std::string lower(std::string s) {
    std::ranges::transform(s, s.begin(), [](unsigned char c) { return char(std::tolower(c)); });
    return s;
}

struct RefEntry {
    std::int32_t hashCode, next;
    Address key, value;
};

class Prober {
public:
    explicit Prober(const eft::Game& game) : game_(game) {}

    LocaleProbeResult run(const std::vector<std::string>& exfilNames) {
        LocaleProbeResult r;
        Json root;
        root["probe"] = "locale v1";
        JsonList names;
        for (const auto& n : exfilNames) names.emplace_back(n);
        root["exfilNames"] = std::move(names);

        const auto fail = [&](std::string why) {
            r.summary = "locale: " + why;
            root["error"] = std::move(why);
            r.json = root.dump();
            return r;
        };

        const auto table = game_.typeInfoTable();
        const auto statics = table ? table->staticFields(LocalizationManagerTypeIndex) : std::nullopt;
        if (!statics || !*statics) return fail("no static fields for EFT.LocalizationManager (type index 8622)");
        const Address instance = eft::readPointer(game_, *statics + LmInstance);
        if (!instance) return fail("LocalizationManager._instance null");
        const auto culture = game_.managed.readStringField(instance + LmCulture, 16).value_or("en");
        root["culture"] = culture;
        const Address locales = eft::readPointer(game_, instance + LmLocales);
        auto cultures = locales ? rawEntries(locales, 64) : std::nullopt;
        if (!cultures || cultures->empty()) return fail("_locales null, empty or unreadable");

        // The current culture's table, else English, else the first.
        JsonList loaded;
        const RefEntry* pick = nullptr;
        for (const auto& c : *cultures) {
            const auto k = string(c.key, 16).value_or("?");
            loaded.emplace_back(k);
            if (k == culture || (k == "en" && !pick)) pick = &c;
        }
        root["cultures"] = std::move(loaded);
        if (!pick) pick = &cultures->front();
        const auto picked = string(pick->key, 16).value_or("?");
        root["picked"] = picked;
        root["pickedClass"] = classOf(pick->value);

        const auto t0 = std::chrono::steady_clock::now();
        auto entries = rawEntries(pick->value, 2'000'000);
        if (!entries) return fail("the picked table isn't a readable Dictionary (EFT.Locale)");
        const auto t1 = std::chrono::steady_clock::now();
        const auto keys = readKeys(*entries);
        const auto t2 = std::chrono::steady_clock::now();
        const auto ms = [](auto a, auto b) { return std::chrono::duration<double, std::milli>(b - a).count(); };
        std::size_t readable = 0;
        for (const auto& k : keys) readable += !k.empty();
        root["entries"] = entries->size();
        root["keysRead"] = readable;
        root["entriesMs"] = ms(t0, t1);
        root["keysMs"] = ms(t1, t2);

        // Ignoring case, as the table does (OrdinalIgnoreCaseComparer).
        std::unordered_map<std::string, std::size_t> byKey;
        std::vector<std::string> lowered(keys.size());
        for (std::size_t i = 0; i < keys.size(); ++i) {
            lowered[i] = lower(keys[i]);
            if (!keys[i].empty()) byKey.emplace(lowered[i], i);
        }

        Json exfils;
        std::size_t found = 0;
        for (const auto& name : exfilNames) {
            Json e;
            const auto want = lower(name);
            if (const auto it = byKey.find(want); it != byKey.end()) {
                e["key"] = keys[it->second];
                e["value"] = value((*entries)[it->second]);
                ++found;
            }
            // Keys that contain it: "<name>_desc", "<map> <name>", ... (the exact one included).
            Json related;
            std::size_t n = 0;
            for (std::size_t i = 0; i < keys.size() && n < kRelatedPerName; ++i)
                if (!want.empty() && lowered[i].find(want) != std::string::npos) {
                    related[keys[i]] = value((*entries)[i]);
                    ++n;
                }
            e["related"] = std::move(related);
            exfils[name] = std::move(e);
        }
        root["exfils"] = std::move(exfils);

        // Keys that look like exits, for any naming scheme the names above don't show.
        Json exitLike;
        std::size_t n = 0;
        for (std::size_t i = 0; i < keys.size() && n < kExitLike; ++i) {
            const auto& k = lowered[i];
            if (k.starts_with("ex_") || k.starts_with("exfil") || k.starts_with("exit") || k.find("_exit") != std::string::npos ||
                k.find("extract") != std::string::npos || k.find("_secret_") != std::string::npos) {
                exitLike[keys[i]] = value((*entries)[i]);
                ++n;
            }
        }
        root["exitLikeCount"] = n;
        root["exitLike"] = std::move(exitLike);

        // Stored hash codes with their keys: for trying more hash functions offline.
        JsonList sample;
        for (std::size_t i = 0; i < keys.size() && sample.size() < kHashSample; ++i) {
            if (keys[i].empty()) continue;
            Json s;
            s["key"] = keys[i];
            s["hash"] = (*entries)[i].hashCode;
            sample.push_back(std::move(s));
        }
        root["hashSample"] = std::move(sample);

        r.json = root.dump();
        r.summary = std::format(
            "locale '{}': {} entries, {} keys read; entries {:.1f} ms, every key {:.1f} ms (batched)\n"
            "{} of {} exfil names found as keys",
            picked, entries->size(), readable, ms(t0, t1), ms(t1, t2), found, exfilNames.size());
        r.ok = readable > 0 && found > 0;
        return r;
    }

private:
    // Dictionary<ref, ref> entries in slot order (freed slots: hash code < 0, kept so indices line up
    // with keys; their keys read as "").
    std::optional<std::vector<RefEntry>> rawEntries(Address dict, std::size_t max) const {
        const auto& L = game_.managed.layout();
        std::int32_t count = 0;
        Address entries = 0;
        if (!game_.mem.tryRead(dict + L.dictCount, count) || count < 0 || std::size_t(count) > max) return std::nullopt;
        if (!game_.mem.tryRead(dict + L.dictEntries, entries) || !mem::MemoryView::isUserPointer(entries))
            return count == 0 ? std::optional(std::vector<RefEntry>{}) : std::nullopt;
        std::vector<RefEntry> out(static_cast<std::size_t>(count));
        if (count && !game_.mem.readBytes(entries + L.arrayData, std::as_writable_bytes(std::span(out))))
            return std::nullopt;
        return out;
    }

    // Every key, in one batch: length and the first kKeyChars code units of each, read together.
    std::vector<std::string> readKeys(const std::vector<RefEntry>& entries) const {
        const auto& L = game_.managed.layout();
        struct Raw {
            std::int32_t length;
            std::array<char16_t, kKeyChars> chars;
        };
        static_assert(sizeof(Raw) == 4 + 2 * kKeyChars);
        const bool adjacent = L.stringChars == L.stringLength + 4;
        std::vector<Raw> raw(entries.size());
        mem::ReadBatch batch(game_.mem);
        std::vector<mem::ReadBatch::Handle> handles(entries.size(), SIZE_MAX);
        for (std::size_t i = 0; i < entries.size(); ++i) {
            const auto& e = entries[i];
            if (e.hashCode < 0 || !mem::MemoryView::isUserPointer(e.key)) continue;
            handles[i] = adjacent ? batch.addBytes(e.key + L.stringLength, &raw[i], sizeof(Raw)) : batch.add(e.key + L.stringLength, raw[i].length);
        }
        batch.execute();
        std::vector<std::string> out(entries.size());
        for (std::size_t i = 0; i < entries.size(); ++i) {
            if (handles[i] == SIZE_MAX || batch.bytesRead(handles[i]) < 4) continue;
            const auto len = raw[i].length;
            if (len <= 0 || len > 4096) continue;
            if (!adjacent) {  // a layout we didn't expect: one string at a time
                out[i] = string(entries[i].key, kKeyChars).value_or("");
                continue;
            }
            // A string near the end of a page can read short; whatever came back is enough to match on.
            const std::size_t got = std::min<std::size_t>({std::size_t(len), kKeyChars, (batch.bytesRead(handles[i]) - 4) / 2});
            out[i] = text::utf16ToUtf8(std::span(raw[i].chars.data(), got));
        }
        return out;
    }

    std::optional<std::string> string(Address s, std::size_t max) const {
        return mem::MemoryView::isUserPointer(s) ? game_.managed.readString(s, max, il2cpp::Managed::Overflow::Truncate)
                                                 : std::nullopt;
    }

    Json value(const RefEntry& e) const {
        auto v = string(e.value, 160);
        return v ? Json(*v) : Json();
    }

    std::string classOf(Address object) const {
        const auto klass = game_.managed.klassOf(object);
        const auto name = klass ? game_.managed.fullClassName(*klass) : std::string{};
        return name.empty() ? "?" : name;
    }

    const eft::Game& game_;
};

}  // namespace

LocaleProbeResult probeLocale(const eft::Game& game, const std::vector<std::string>& exfilNames) {
    return Prober(game).run(exfilNames);
}

}  // namespace radar::app
