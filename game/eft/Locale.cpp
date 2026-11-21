#include "game/eft/Locale.hpp"

#include "core/log/Log.hpp"
#include "core/mem/ReadBatch.hpp"
#include "core/text/Ascii.hpp"
#include "core/text/Utf16.hpp"
#include "game/eft/Read.hpp"

#include <eft_offsets.hpp>

#include <algorithm>
#include <cstdint>
#include <vector>

namespace radar::eft {

namespace {

using mem::Address;

constexpr std::size_t kMaxCultures = 64;
constexpr std::size_t kMaxEntries = 2'000'000;
constexpr std::size_t kMaxKeyChars = 256;
constexpr std::size_t kMaxText = 256;


// The text table to look in: the current culture's, else English, else none.
Address currentTable(const Game& game) {
    const auto types = game.typeInfoTable();
    const auto statics = types ? types->staticFields(off::LocalizationManager::TypeIndex) : std::nullopt;
    if (!statics || !*statics) return 0;
    const Address manager = readPointer(game, *statics + off::LocalizationManager::Instance);
    if (!manager) return 0;
    const auto culture =
        text::lowerAscii(game.managed.readStringField(manager + off::LocalizationManager::Culture, 16).value_or("en"));
    const Address locales = readPointer(game, manager + off::LocalizationManager::Locales);
    const auto cultures = locales ? game.managed.readDictionary<Address, Address>(locales, kMaxCultures) : std::nullopt;
    if (!cultures) return 0;
    Address english = 0;
    for (const auto& [key, value] : *cultures) {
        if (!mem::MemoryView::isUserPointer(value)) continue;
        const auto name = text::lowerAscii(game.managed.readString(key, 16).value_or(""));
        if (name == culture) return value;
        if (name == "en") english = value;
    }
    return english;
}

}  // namespace

std::unordered_map<std::string, std::string> lookupTexts(const Game& game, std::span<const std::string> keys) {
    std::unordered_map<std::string, std::string> found;
    // Lowercased wanted key → the keys asked for (a name can be asked twice in different case).
    std::unordered_map<std::string, std::vector<const std::string*>> wanted;
    std::vector<bool> wantedLengths(kMaxKeyChars + 1);
    for (const auto& k : keys) {
        if (k.empty() || k.size() > kMaxKeyChars) continue;  // keys are ASCII: bytes = UTF-16 code units
        wanted[text::lowerAscii(k)].push_back(&k);
        wantedLengths[k.size()] = true;
    }
    if (wanted.empty()) return found;

    const Address table = currentTable(game);
    const auto entries = table ? game.managed.readDictionary<Address, Address>(table, kMaxEntries) : std::nullopt;
    if (!entries) {
        log::debug("locale: no text table");
        return found;
    }
    const auto& L = game.managed.layout();

    // Every key's length, then the characters of the keys as long as one we want.
    std::vector<std::int32_t> length(entries->size(), 0);  // 0: unreadable
    std::size_t noLength = 0;
    {
        mem::ReadBatch batch(game.mem);
        std::vector<std::pair<std::size_t, mem::ReadBatch::Handle>> reads;
        for (std::size_t i = 0; i < entries->size(); ++i)
            if (mem::MemoryView::isUserPointer((*entries)[i].first))
                reads.emplace_back(i, batch.add((*entries)[i].first + L.stringLength, length[i]));
        batch.execute();
        for (const auto& [i, h] : reads) noLength += !batch.complete(h);
    }
    std::vector<std::size_t> candidates;
    for (std::size_t i = 0; i < entries->size(); ++i)
        if (length[i] > 0 && std::size_t(length[i]) <= kMaxKeyChars && wantedLengths[std::size_t(length[i])]) candidates.push_back(i);
    std::vector<std::u16string> chars(candidates.size());
    std::vector<mem::ReadBatch::Handle> handles(candidates.size());
    mem::ReadBatch batch(game.mem);
    for (std::size_t c = 0; c < candidates.size(); ++c) {
        chars[c].resize(std::size_t(length[candidates[c]]));
        handles[c] = batch.addBytes((*entries)[candidates[c]].first + L.stringChars, chars[c].data(), chars[c].size() * 2);
    }
    batch.execute();

    std::size_t unread = 0;
    for (std::size_t c = 0; c < candidates.size(); ++c) {
        if (!batch.complete(handles[c])) {
            ++unread;
            continue;
        }
        const auto it = wanted.find(text::lowerAscii(text::utf16ToUtf8(chars[c])));
        if (it == wanted.end()) continue;
        const auto translated =
            game.managed.readString((*entries)[candidates[c]].second, kMaxText, il2cpp::Managed::Overflow::Truncate);
        if (!translated || translated->empty()) continue;
        for (const std::string* k : it->second) found.emplace(*k, *translated);
    }
    log::debug("locale: {} of {} keys found among {} entries ({} of the same length; unreadable: {} lengths, {} keys)",
               found.size(), keys.size(), entries->size(), candidates.size(), noLength, unread);
    return found;
}

}  // namespace radar::eft
