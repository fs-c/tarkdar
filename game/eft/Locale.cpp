#include "game/eft/Locale.hpp"

#include "core/log/Log.hpp"
#include "core/mem/ReadBatch.hpp"
#include "core/text/Utf16.hpp"
#include "game/eft/Read.hpp"

#include <eft_offsets.hpp>

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <vector>

namespace radar::eft {

namespace {

using mem::Address;

constexpr std::size_t kMaxCultures = 64;
constexpr std::size_t kMaxEntries = 2'000'000;
constexpr std::size_t kMaxKeyChars = 256;
constexpr std::size_t kMaxText = 256;

std::string lower(std::string_view s) {
    std::string out(s);
    std::ranges::transform(out, out.begin(), [](unsigned char c) { return char(std::tolower(c)); });
    return out;
}

// Dictionary<string, string> entries in slot order (freed slots have a negative hash code).
struct Entry {
    std::int32_t hashCode, next;
    Address key, value;
};

std::optional<std::vector<Entry>> readEntries(const Game& game, Address dict, std::size_t max) {
    const auto& L = game.managed.layout();
    std::int32_t count = 0;
    Address entries = 0;
    if (!game.mem.tryRead(dict + L.dictCount, count) || count < 0 || std::size_t(count) > max) return std::nullopt;
    if (count == 0) return std::vector<Entry>{};
    if (!game.mem.tryRead(dict + L.dictEntries, entries) || !mem::MemoryView::isUserPointer(entries)) return std::nullopt;
    std::vector<Entry> out(static_cast<std::size_t>(count));
    if (!game.mem.readBytes(entries + L.arrayData, std::as_writable_bytes(std::span(out)))) return std::nullopt;
    return out;
}

// The text table to look in: the current culture's, else English, else none.
Address currentTable(const Game& game) {
    const auto types = game.typeInfoTable();
    const auto statics = types ? types->staticFields(off::LocalizationManager::TypeIndex) : std::nullopt;
    if (!statics || !*statics) return 0;
    const Address manager = readPointer(game, *statics + off::LocalizationManager::Instance);
    if (!manager) return 0;
    const auto culture = lower(game.managed.readStringField(manager + off::LocalizationManager::Culture, 16).value_or("en"));
    const Address locales = readPointer(game, manager + off::LocalizationManager::Locales);
    const auto cultures = locales ? readEntries(game, locales, kMaxCultures) : std::nullopt;
    if (!cultures) return 0;
    Address english = 0;
    for (const auto& c : *cultures) {
        if (c.hashCode < 0 || !mem::MemoryView::isUserPointer(c.value)) continue;
        const auto name = lower(game.managed.readString(c.key, 16).value_or(""));
        if (name == culture) return c.value;
        if (name == "en") english = c.value;
    }
    return english;
}

}  // namespace

std::unordered_map<std::string, std::string> lookupTexts(const Game& game, std::span<const std::string> keys) {
    std::unordered_map<std::string, std::string> found;
    // Lowercased wanted key → the keys asked for (a name can be asked twice in different case).
    std::unordered_map<std::string, std::vector<const std::string*>> wanted;
    std::vector<bool> lengths(kMaxKeyChars + 1);
    for (const auto& k : keys) {
        if (k.empty() || k.size() > kMaxKeyChars) continue;  // keys are ASCII: bytes = UTF-16 code units
        wanted[lower(k)].push_back(&k);
        lengths[k.size()] = true;
    }
    if (wanted.empty()) return found;

    const Address table = currentTable(game);
    const auto entries = table ? readEntries(game, table, kMaxEntries) : std::nullopt;
    if (!entries) {
        log::debug("locale: no text table");
        return found;
    }
    const auto& L = game.managed.layout();

    // Every key's length, then the characters of the keys as long as one we want.
    std::vector<std::int32_t> length(entries->size(), 0);  // 0: freed, or unreadable
    std::size_t noLength = 0;
    {
        mem::ReadBatch batch(game.mem);
        std::vector<std::pair<std::size_t, mem::ReadBatch::Handle>> reads;
        for (std::size_t i = 0; i < entries->size(); ++i)
            if ((*entries)[i].hashCode >= 0 && mem::MemoryView::isUserPointer((*entries)[i].key))
                reads.emplace_back(i, batch.add((*entries)[i].key + L.stringLength, length[i]));
        batch.execute();
        for (const auto& [i, h] : reads) noLength += !batch.complete(h);
    }
    std::vector<std::size_t> candidates;
    for (std::size_t i = 0; i < entries->size(); ++i)
        if (length[i] > 0 && std::size_t(length[i]) <= kMaxKeyChars && lengths[std::size_t(length[i])]) candidates.push_back(i);
    std::vector<std::u16string> chars(candidates.size());
    std::vector<mem::ReadBatch::Handle> handles(candidates.size());
    mem::ReadBatch batch(game.mem);
    for (std::size_t c = 0; c < candidates.size(); ++c) {
        chars[c].resize(std::size_t(length[candidates[c]]));
        handles[c] = batch.addBytes((*entries)[candidates[c]].key + L.stringChars, chars[c].data(), chars[c].size() * 2);
    }
    batch.execute();

    std::size_t unread = 0;
    for (std::size_t c = 0; c < candidates.size(); ++c) {
        if (!batch.complete(handles[c])) {
            ++unread;
            continue;
        }
        const auto it = wanted.find(lower(text::utf16ToUtf8(chars[c])));
        if (it == wanted.end()) continue;
        const auto text = game.managed.readString((*entries)[candidates[c]].value, kMaxText, il2cpp::Managed::Overflow::Truncate);
        if (!text || text->empty()) continue;
        for (const std::string* k : it->second) found.emplace(*k, *text);
    }
    log::debug("locale: {} of {} keys found among {} entries ({} of the same length; unreadable: {} lengths, {} keys)",
               found.size(), keys.size(), entries->size(), candidates.size(), noLength, unread);
    return found;
}

}  // namespace radar::eft
