#include "app/QuestProbe.hpp"

#include "game/eft/Read.hpp"
#include "game/eft/model/Quests.hpp"

#include <eft_offsets.hpp>

#include <crow/json.h>

#include <array>
#include <cstring>
#include <format>
#include <map>
#include <set>
#include <span>

namespace radar::app {

namespace {

using mem::Address;
using mem::Freshness;
using Json = crow::json::wvalue;
using JsonList = std::vector<Json>;

// From dumps/il2cpp-dump.json (GameAssembly 0x6AF739B7). Probe-only: they move to eft.offsets.json once
// confirmed.
namespace qoff {
inline constexpr std::uint32_t StatusTemplate = 0x38;  // QuestStatusData.Template
inline constexpr std::uint32_t StatusQuest = 0x40;     // QuestStatusData.Quest
inline constexpr std::uint32_t QuestTemplate = 0x70;   // Quest._template

// QuestTemplate
inline constexpr std::uint32_t TId = 0x10, TLocationId = 0x18, TLevel = 0x20, TRestartable = 0x24, TTraderId = 0x28,
                               TQuestType = 0x40, TTemplateId = 0x48, TAppearStatus = 0x50, TKeyQuest = 0x54,
                               TConditions = 0x68, TCanShowNotifications = 0x70, TInstantComplete = 0x71,
                               TPlayerGroup = 0x74, TTier = 0x78, TServerOnly = 0x7C, TInBufferZoneOnly = 0xA8,
                               TIsInvisible = 0xA9, TQuestName = 0xD0, TRankingModes = 0x110, TGameModes = 0x118,
                               TArenaLocationIds = 0x120, TIsMainQuest = 0x128;
inline constexpr std::size_t TemplateSize = 0x130;

// Condition and subclasses
inline constexpr std::uint32_t CId = 0x10 /* MongoID inline */, CValue = 0x28, CCompare = 0x2C, CVisibility = 0x30,
                               CIndex = 0x38, CDynamicLocale = 0x60, CNecessary = 0x61, CChildren = 0x68,
                               CResetOnSessionEnd = 0x70;
inline constexpr std::uint32_t CTarget = 0xE0;  // ConditionOneTarget: string, ConditionMultipleTargets: string[]
inline constexpr std::uint32_t CMinDurability = 0xE8, CMaxDurability = 0xEC, CDogtagLevel = 0xF0, COnlyFir = 0xF4,
                               CIsEncoded = 0xF5, CIncludeEquipment = 0xF6;  // ConditionItem
inline constexpr std::uint32_t CCountInRaid = 0xF8;                         // ConditionFindItem
inline constexpr std::uint32_t CZoneIds = 0xE8;                             // ConditionZone
inline constexpr std::uint32_t CPlantTime = 0xF0;                           // ConditionLeaveItemAtLocation
inline constexpr std::uint32_t CCounterConditions = 0xE8, CCounterType = 0xF0;  // ConditionCounterCreator
inline constexpr std::size_t ConditionSize = 0x100;

// BindableList`1.List (generic class: offset unknown in the dump; guessed from the field order, and
// scanned for if wrong)
inline constexpr std::uint32_t BindableListList = 0x58;

// Profile.TaskConditionCounters; TaskConditionCounter
inline constexpr std::uint32_t ProfileCounters = 0x90;
inline constexpr std::uint32_t KId = 0x18 /* MongoID inline */, KType = 0x30, KSourceId = 0x38, KValue = 0x40,
                               KTemplate = 0x48;

// v2
inline constexpr std::uint32_t StatusStartTime = 0x18;     // QuestStatusData.StartTime (int32)
inline constexpr std::uint32_t TLocalization = 0xB0;       // QuestTemplate.<Localization>k__BackingField
inline constexpr std::uint32_t TExpirationTime = 0x138;    // RepeatableQuestTemplate.<ExpirationTime>k__BackingField
inline constexpr std::int32_t LocalizationManagerTypeIndex = 8622;  // EFT.LocalizationManager
inline constexpr std::uint32_t LmStaticLocales = 0x0, LmInstance = 0x8;  // static fields
inline constexpr std::uint32_t LmLocales = 0x38, LmCurrentCulture = 0x48, LmCulture = 0x70;
}  // namespace qoff

// Candidate string hashes (over UTF-16 code units) for finding locale keys by Dictionary entry hash
// without reading every key.
std::int32_t hashNetLegacy64(const std::u16string& s) {  // .NET reference source, 64-bit (int pairs)
    std::u16string z = s;
    z.push_back(0);  // the terminator is read as the high half of the last pair
    std::uint32_t h1 = (5381u << 16) + 5381u, h2 = h1;
    std::size_t i = 0;
    const auto word = [&](std::size_t at) {
        return std::uint32_t(z[at]) | (at + 1 < z.size() ? std::uint32_t(z[at + 1]) << 16 : 0u);
    };
    std::ptrdiff_t len = std::ptrdiff_t(s.size());
    while (len > 2) {
        h1 = ((h1 << 5) + h1 + std::uint32_t(std::int32_t(h1) >> 27)) ^ word(i);
        h2 = ((h2 << 5) + h2 + std::uint32_t(std::int32_t(h2) >> 27)) ^ word(i + 2);
        i += 4;
        len -= 4;
    }
    if (len > 0) h1 = ((h1 << 5) + h1 + std::uint32_t(std::int32_t(h1) >> 27)) ^ word(i);
    return std::int32_t(h1 + h2 * 1566083941u);
}
std::int32_t hashNetLegacy32(const std::u16string& s) {  // .NET reference source, 32-bit (chars)
    std::uint32_t h1 = (5381u << 16) + 5381u, h2 = h1;
    for (std::size_t i = 0; i < s.size(); i += 2) {
        h1 = ((h1 << 5) + h1) ^ s[i];
        if (i + 1 < s.size()) h2 = ((h2 << 5) + h2) ^ s[i + 1];
    }
    return std::int32_t(h1 + h2 * 1566083941u);
}
std::int32_t hashMono(const std::u16string& s) {  // old Mono: h = h * 31 + c
    std::uint32_t h = 0;
    for (char16_t c : s) h = (h << 5) - h + c;
    return std::int32_t(h);
}
std::u16string widen(const std::string& s) { return {s.begin(), s.end()}; }  // keys are ASCII

constexpr int kMaxDepth = 5;
constexpr std::size_t kMaxConditions = 512;
constexpr std::size_t kMaxStrings = 256;

const char* statusName(std::int32_t s) {
    static constexpr const char* names[] = {"Locked",  "AvailableForStart", "Started",       "AvailableForFinish",
                                            "Success", "Fail",              "FailRestartable", "MarkedAsFailed",
                                            "Expired", "AvailableAfter",    "AutoStart"};
    return s >= 0 && s < std::int32_t(std::size(names)) ? names[s] : "?";
}

const char* questTypeName(std::int32_t t) {
    static constexpr const char* names[] = {"PickUp", "Elimination", "Discover", "Completion", "Exploration",
                                            "Levelling", "Experience", "Standing", "Loyalty", "Merchant",
                                            "Skill", "Multi", "WeaponAssembly", "ArenaWinMatch", "ArenaWinRound"};
    return t >= 0 && t < std::int32_t(std::size(names)) ? names[t] : "?";
}

template <std::size_t N>
struct Blob {
    std::array<std::byte, N> b;
    template <class T>
    [[nodiscard]] T at(std::size_t off) const {
        T v{};
        std::memcpy(&v, b.data() + off, sizeof v);
        return v;
    }
};

class Prober {
public:
    explicit Prober(const eft::Game& game) : game_(game) {}

    std::string hex(Address a) const { return std::format("{:#x}", a); }

    std::string classOf(Address object) const {
        const auto klass = game_.managed.klassOf(object);
        const auto name = klass ? game_.managed.fullClassName(*klass) : std::string{};
        return name.empty() ? "?" : name;
    }

    // Class and base classes, most derived first.
    JsonList ancestry(Address object) const {
        JsonList out;
        auto klass = game_.managed.klassOf(object);
        for (int i = 0; klass && i < 16; ++i) {
            const auto name = game_.managed.fullClassName(*klass);
            if (name.empty() || name == "System.Object") break;
            out.emplace_back(name);
            klass = game_.managed.parentClass(*klass);
        }
        return out;
    }

    bool isA(Address object, std::string_view name) const { return game_.managed.isInstanceOf(object, name); }

    Json str(Address field, std::size_t max = 256) const {
        auto s = game_.managed.readStringField(field, max, il2cpp::Managed::Overflow::Truncate);
        return s ? Json(*s) : Json();
    }

    Json mongo(Address inlineId) const {
        auto s = eft::readMongoId(game_, inlineId);
        return s ? Json(*s) : Json();
    }

    Json strings(Address arrayField) const {
        const Address arr = eft::readPointer(game_, arrayField);
        if (!arr) return Json();
        auto ptrs = game_.managed.readArray<Address>(arr, kMaxStrings);
        if (!ptrs) return Json("unreadable");
        JsonList out;
        for (Address p : *ptrs) {
            auto s = p ? game_.managed.readString(p, 256, il2cpp::Managed::Overflow::Truncate) : std::nullopt;
            out.push_back(s ? Json(*s) : Json());
        }
        return out;
    }

    // Pointer fields of an object and their classes: for finding a field the dump has no offset for.
    Json fields(Address object, std::uint32_t from, std::uint32_t to) const {
        Json out;
        for (std::uint32_t off = from; off < to; off += 8) {
            const Address p = eft::readPointer(game_, object + off);
            if (p) out[hex(off)] = classOf(p);
        }
        return out;
    }

    // The conditions in a container: a List`1, an array, or an object holding a List`1 (BindableList /
    // ConditionCollection). `how` says which, for the report.
    std::optional<std::vector<Address>> conditionsIn(Address container, std::string& how) const {
        const auto cls = classOf(container);
        if (cls.ends_with("[]")) {
            how = "array";
            return game_.managed.readArray<Address>(container, kMaxConditions);
        }
        if (cls.starts_with("System.Collections.Generic.List`1") || cls == "List`1") {
            how = "List`1";
            return game_.managed.readList<Address>(container, kMaxConditions);
        }
        const auto tryAt = [&](std::uint32_t off) -> std::optional<std::vector<Address>> {
            const Address list = eft::readPointer(game_, container + off);
            if (!list) return std::nullopt;
            const auto lc = classOf(list);
            if (!lc.starts_with("System.Collections.Generic.List`1") && lc != "List`1") return std::nullopt;
            auto items = game_.managed.readList<Address>(list, kMaxConditions);
            if (items) how = std::format("{} via List`1 at {}", cls, hex(off));
            return items;
        };
        if (auto r = tryAt(qoff::BindableListList)) return r;
        for (std::uint32_t off = 0x10; off < 0x80; off += 8)
            if (off != qoff::BindableListList)
                if (auto r = tryAt(off)) return r;
        how = "unknown container " + cls;
        return std::nullopt;
    }

    Json conditionList(Address container, int depth) {
        Json out;
        if (!container) return out;
        std::string how;
        auto items = conditionsIn(container, how);
        out["via"] = how;
        if (!items) {
            out["fields"] = fields(container, 0x10, 0x80);
            return out;
        }
        JsonList list;
        for (Address c : *items) list.push_back(condition(c, depth));
        out["items"] = std::move(list);
        return out;
    }

    Json condition(Address c, int depth) {
        Json out;
        if (!mem::MemoryView::isUserPointer(c)) return out;
        ++conditions_;
        Blob<qoff::ConditionSize> b{};
        if (!game_.mem.tryRead(c, b)) {
            out["unreadable"] = hex(c);
            return out;
        }
        const auto cls = classOf(c);
        ++classes_[cls];
        out["class"] = cls;
        out["ancestry"] = ancestry(c);
        out["id"] = mongo(c + qoff::CId);
        out["value"] = double(b.at<float>(qoff::CValue));
        out["compare"] = b.at<std::int32_t>(qoff::CCompare);
        out["index"] = b.at<std::int32_t>(qoff::CIndex);
        out["necessary"] = b.at<bool>(qoff::CNecessary);
        out["dynamicLocale"] = b.at<bool>(qoff::CDynamicLocale);
        out["resetOnSessionEnd"] = b.at<bool>(qoff::CResetOnSessionEnd);

        if (isA(c, "EFT.Quests.ConditionMultipleTargets")) out["target"] = strings(c + qoff::CTarget);
        else if (isA(c, "EFT.Quests.ConditionOneTarget")) out["target"] = str(c + qoff::CTarget);
        if (isA(c, "EFT.Quests.ConditionItem")) {
            ++itemConditions_;
            out["minDurability"] = b.at<std::int32_t>(qoff::CMinDurability);
            out["maxDurability"] = b.at<std::int32_t>(qoff::CMaxDurability);
            out["dogtagLevel"] = b.at<std::int32_t>(qoff::CDogtagLevel);
            out["onlyFoundInRaid"] = b.at<bool>(qoff::COnlyFir);
            out["isEncoded"] = b.at<bool>(qoff::CIsEncoded);
            out["includeEquipment"] = b.at<bool>(qoff::CIncludeEquipment);
        }
        if (isA(c, "EFT.Quests.ConditionFindItem")) out["countInRaid"] = b.at<bool>(qoff::CCountInRaid);
        if (isA(c, "EFT.Quests.ConditionZone")) out["zoneIds"] = strings(c + qoff::CZoneIds);
        if (isA(c, "EFT.Quests.ConditionLeaveItemAtLocation")) out["plantTime"] = double(b.at<float>(qoff::CPlantTime));

        if (depth < kMaxDepth) {
            if (isA(c, "EFT.Quests.ConditionCounterCreator")) {
                out["counterType"] = questTypeName(b.at<std::int32_t>(qoff::CCounterType));
                out["counterConditions"] = conditionList(b.at<Address>(qoff::CCounterConditions), depth + 1);
            }
            if (const Address kids = b.at<Address>(qoff::CChildren); mem::MemoryView::isUserPointer(kids))
                out["children"] = conditionList(kids, depth + 1);
            if (const Address vis = b.at<Address>(qoff::CVisibility); mem::MemoryView::isUserPointer(vis))
                out["visibility"] = conditionList(vis, depth + 1);
        }
        return out;
    }

    Json templ(Address t) {
        Json out;
        Blob<qoff::TemplateSize> b{};
        if (!game_.mem.tryRead(t, b)) {
            out["unreadable"] = hex(t);
            return out;
        }
        out["class"] = classOf(t);
        out["id"] = str(t + qoff::TId);
        out["templateId"] = str(t + qoff::TTemplateId);
        out["locationId"] = str(t + qoff::TLocationId);
        out["traderId"] = str(t + qoff::TTraderId);
        out["questName"] = str(t + qoff::TQuestName);
        if (auto key = game_.managed.readStringField(t + qoff::TQuestName, 256)) wanted_.insert(*key);
        if (auto id = game_.managed.readStringField(t + qoff::TId, 64)) wanted_.insert(*id + " name");
        if (auto trader = game_.managed.readStringField(t + qoff::TTraderId, 64)) wanted_.insert(*trader + " Nickname");
        if (isA(t, "EFT.Quests.RepeatableQuestTemplate")) {
            std::int32_t expiration = 0;
            game_.mem.tryRead(t + qoff::TExpirationTime, expiration);
            out["expirationTime"] = expiration;
        }
        if (const Address loc = b.at<Address>(qoff::TLocalization); mem::MemoryView::isUserPointer(loc))
            out["localization"] = dictionary(loc, 2, 12);
        out["level"] = b.at<std::int32_t>(qoff::TLevel);
        const auto type = b.at<std::int32_t>(qoff::TQuestType);
        out["questType"] = std::format("{} ({})", questTypeName(type), type);
        out["appearStatus"] = statusName(b.at<std::int32_t>(qoff::TAppearStatus));
        out["playerGroup"] = b.at<std::int32_t>(qoff::TPlayerGroup);
        out["tier"] = b.at<std::int32_t>(qoff::TTier);
        const bool main = b.at<bool>(qoff::TIsMainQuest), invisible = b.at<bool>(qoff::TIsInvisible),
                   serverOnly = b.at<bool>(qoff::TServerOnly);
        out["isMainQuest"] = main;
        out["isInvisible"] = invisible;
        out["serverOnly"] = serverOnly;
        out["restartable"] = b.at<bool>(qoff::TRestartable);
        out["keyQuest"] = b.at<bool>(qoff::TKeyQuest);
        out["instantComplete"] = b.at<bool>(qoff::TInstantComplete);
        out["inBufferZoneOnly"] = b.at<bool>(qoff::TInBufferZoneOnly);
        out["canShowNotificationsInGame"] = b.at<bool>(qoff::TCanShowNotifications);
        out["gameModes"] = strings(t + qoff::TGameModes);
        out["rankingModes"] = strings(t + qoff::TRankingModes);
        out["arenaLocationIds"] = strings(t + qoff::TArenaLocationIds);
        if (main) ++main_;
        if (invisible) ++invisible_;
        if (serverOnly) ++serverOnly_;
        ++types_[questTypeName(type)];

        // ConditionsDict: Dictionary<EQuestStatus, ConditionCollection>.
        const Address dict = b.at<Address>(qoff::TConditions);
        if (!mem::MemoryView::isUserPointer(dict)) {
            out["conditions"] = "null";
            return out;
        }
        auto entries = game_.managed.readDictionary<std::int32_t, Address>(dict, 32);
        if (!entries) {
            Json bad;
            bad["unreadable"] = classOf(dict);
            bad["fields"] = fields(dict, 0x10, 0x50);
            out["conditions"] = std::move(bad);
            return out;
        }
        Json conds;
        for (const auto& [status, collection] : *entries)
            conds[std::format("{} ({})", statusName(status), status)] = conditionList(collection, 0);
        out["conditions"] = std::move(conds);
        return out;
    }

    Json quest(Address entry, std::int32_t status) {
        Json out;
        out["id"] = str(entry + off::QuestsData::Id, 64);
        out["status"] = std::format("{} ({})", statusName(status), status);
        std::int32_t startTime = 0;
        game_.mem.tryRead(entry + qoff::StatusStartTime, startTime);
        out["startTime"] = startTime;
        Address t = eft::readPointer(game_, entry + qoff::StatusTemplate);
        const Address q = eft::readPointer(game_, entry + qoff::StatusQuest);
        out["hasQuestObject"] = q != 0;
        std::string from = "QuestStatusData.Template";
        if (!t && q) {
            t = eft::readPointer(game_, q + qoff::QuestTemplate);
            from = "Quest._template";
        }
        if (!t) {
            out["template"] = Json();
            return out;
        }
        ++templates_;
        out["templateFrom"] = from;
        out["template"] = templ(t);
        return out;
    }

    // Profile.TaskConditionCounters: probably Dictionary<MongoID or string, TaskConditionCounter>.
    Json counters(Address profile) {
        Json out;
        const Address obj = eft::readPointer(game_, profile + qoff::ProfileCounters, Freshness::Fresh);
        if (!obj) {
            out["error"] = "null";
            return out;
        }
        out["class"] = classOf(obj);
        struct MongoKey {
            std::uint32_t timestamp;
            std::uint64_t counter;
            Address stringId;
        };
        std::vector<Address> values;
        const auto take = [&](auto&& entries, const char* key) {
            if (!entries || entries->empty()) return false;
            std::size_t good = 0;
            for (const auto& [k, v] : *entries) good += isA(v, "TaskConditionCounter");
            if (good * 2 < entries->size()) return false;
            for (const auto& [k, v] : *entries) values.push_back(v);
            out["key"] = key;
            return true;
        };
        if (!take(game_.managed.readDictionary<MongoKey, Address>(obj, 16384, Freshness::Fresh), "MongoID") &&
            !take(game_.managed.readDictionary<Address, Address>(obj, 16384, Freshness::Fresh), "reference")) {
            out["error"] = "not a dictionary of TaskConditionCounter (or empty)";
            out["fields"] = fields(obj, 0x10, 0x60);
            return out;
        }
        JsonList list;
        for (Address v : values) {
            Json c;
            c["id"] = mongo(v + qoff::KId);
            c["type"] = str(v + qoff::KType);
            c["sourceId"] = str(v + qoff::KSourceId);
            std::int32_t value = 0;
            game_.mem.tryRead(v + qoff::KValue, value, Freshness::Fresh);
            c["value"] = value;
            if (const Address t = eft::readPointer(game_, v + qoff::KTemplate)) {
                c["conditionId"] = mongo(t + qoff::CId);
                c["conditionClass"] = classOf(t);
            }
            list.push_back(std::move(c));
        }
        counters_ = list.size();
        out["items"] = std::move(list);
        return out;
    }

    // Raw Dictionary<ref, ref> entries, with their stored hash codes (freed slots dropped).
    struct RefEntry {
        std::int32_t hashCode, next;
        Address key, value;
    };
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
        std::erase_if(out, [](const RefEntry& e) { return e.hashCode < 0; });
        return out;
    }

    std::optional<std::string> string(Address s, std::size_t max = 256) const {
        return mem::MemoryView::isUserPointer(s) ? game_.managed.readString(s, max, il2cpp::Managed::Overflow::Truncate)
                                                 : std::nullopt;
    }

    // A Dictionary with string keys: its class, count and first entries; values that are strings are
    // read, dictionaries recursed into (up to `depth`), anything else named by class.
    Json dictionary(Address dict, int depth, std::size_t show) const {
        Json out;
        out["class"] = classOf(dict);
        auto entries = rawEntries(dict, 1'000'000);
        if (!entries) {
            out["error"] = "not a readable Dictionary";
            out["fields"] = fields(dict, 0x10, 0x60);
            return out;
        }
        out["count"] = entries->size();
        Json items;
        for (std::size_t i = 0; i < std::min(show, entries->size()); ++i) {
            const auto& e = (*entries)[i];
            const auto key = string(e.key, 128).value_or(std::format("<{}>", classOf(e.key)));
            const auto vc = classOf(e.value);
            if (vc == "System.String") items[key] = string(e.value).value_or("?");
            else if (vc.starts_with("System.Collections.Generic.Dictionary`2") && depth > 0)
                items[key] = dictionary(e.value, depth - 1, show);
            else items[key] = "<" + vc + ">";
        }
        out["entries"] = std::move(items);
        return out;
    }

    // The game's text tables (EFT.LocalizationManager): which hash the dictionaries use, and the
    // quest and trader names the probe collected keys for.
    Json locale() {
        Json out;
        const auto table = game_.typeInfoTable();
        const auto statics = table ? table->staticFields(qoff::LocalizationManagerTypeIndex) : std::nullopt;
        if (const auto klass = table ? table->klass(qoff::LocalizationManagerTypeIndex) : std::nullopt)
            out["class"] = game_.managed.fullClassName(*klass);
        if (!statics || !*statics) {
            out["error"] = "no static fields for LocalizationManager (type index)";
            return out;
        }
        const Address instance = eft::readPointer(game_, *statics + qoff::LmInstance);
        if (const Address sl = eft::readPointer(game_, *statics + qoff::LmStaticLocales)) out["staticLocales"] = dictionary(sl, 0, 8);
        if (!instance) {
            out["error"] = "LocalizationManager._instance null";
            return out;
        }
        out["instanceClass"] = classOf(instance);
        out["culture"] = str(instance + qoff::LmCulture);
        out["currentApplicationCulture"] = str(instance + qoff::LmCurrentCulture);
        const Address locales = eft::readPointer(game_, instance + qoff::LmLocales);
        if (!locales) {
            out["error"] = "_locales null";
            return out;
        }
        out["locales"] = dictionary(locales, 0, 16);
        auto cultures = rawEntries(locales, 64);
        if (!cultures || cultures->empty()) {
            out["error"] = "_locales empty or unreadable";
            return out;
        }
        // Prefer the current culture, then English, then whatever there is.
        const auto culture = game_.managed.readStringField(instance + qoff::LmCulture, 16).value_or("en");
        const RefEntry* pick = &cultures->front();
        for (const auto& c : *cultures) {
            const auto k = string(c.key, 16).value_or("");
            if (k == culture || (k == "en" && string(pick->key, 16).value_or("") != culture)) pick = &c;
        }
        out["picked"] = string(pick->key, 16).value_or("?");
        Address table2 = pick->value;
        out["pickedClass"] = classOf(table2);
        if (!classOf(table2).starts_with("System.Collections.Generic.Dictionary`2")) {
            out["pickedFields"] = fields(table2, 0x10, 0x80);  // a wrapper: find its dictionary
            for (std::uint32_t off = 0x10; off < 0x80; off += 8) {
                const Address p = eft::readPointer(game_, table2 + off);
                if (p && classOf(p).starts_with("System.Collections.Generic.Dictionary`2")) {
                    out["pickedDictionaryAt"] = hex(off);
                    table2 = p;
                    break;
                }
            }
        }
        auto entries = rawEntries(table2, 2'000'000);
        if (!entries) {
            out["error"] = "picked table unreadable";
            return out;
        }
        out["entries"] = entries->size();
        localeEntries_ = entries->size();

        // Which hash: compare the stored hash codes of the first entries with each candidate.
        struct Algo {
            const char* name;
            std::int32_t (*fn)(const std::u16string&);
            int hits = 0;
        };
        std::array<Algo, 3> algos{{{"netLegacy64", hashNetLegacy64}, {"netLegacy32", hashNetLegacy32}, {"mono", hashMono}}};
        JsonList sample;
        const std::size_t tested = std::min<std::size_t>(64, entries->size());
        for (std::size_t i = 0; i < tested; ++i) {
            const auto& e = (*entries)[i];
            const auto key = string(e.key, 512);
            if (!key) continue;
            if (sample.size() < 8) {
                Json s;
                s["key"] = *key;
                s["value"] = string(e.value, 120).value_or("?");
                s["hash"] = e.hashCode;
                sample.push_back(std::move(s));
            }
            for (auto& a : algos) a.hits += (a.fn(widen(*key)) & 0x7FFFFFFF) == e.hashCode;
        }
        out["sample"] = std::move(sample);
        Json hashes;
        const Algo* best = nullptr;
        for (const auto& a : algos) {
            hashes[a.name] = std::format("{}/{}", a.hits, tested);
            if (a.hits * 10 >= int(tested) * 9 && (!best || a.hits > best->hits)) best = &a;
        }
        out["hashMatches"] = std::move(hashes);
        if (!best) {
            out["error"] = "no candidate hash matches the stored hash codes";
            return out;
        }
        hashAlgo_ = best->name;

        // Look the collected keys up by hash, confirm by reading the key.
        std::multimap<std::int32_t, const RefEntry*> byHash;
        for (const auto& e : *entries) byHash.emplace(e.hashCode, &e);
        Json found;
        JsonList missing;
        for (const auto& key : wanted_) {
            const auto h = best->fn(widen(key)) & 0x7FFFFFFF;
            const auto [lo, hi] = byHash.equal_range(h);
            bool hit = false;
            for (auto it = lo; it != hi && !hit; ++it)
                if (string(it->second->key, 512) == key) {
                    found[key] = string(it->second->value, 200).value_or("?");
                    hit = true;
                }
            if (hit) ++namesFound_;
            else missing.emplace_back(key);
        }
        out["found"] = std::move(found);
        out["missing"] = std::move(missing);
        return out;
    }

    QuestProbeResult run(Address localPlayer) {
        QuestProbeResult r;
        Json root;
        root["probe"] = "quests v2";
        const Address profile = eft::readPointer(game_, localPlayer + off::Player::Profile);
        const Address list = profile ? eft::readPointer(game_, profile + off::Profile::QuestsData, Freshness::Fresh) : 0;
        const auto entries = list ? game_.managed.readList<Address>(list, 4096, Freshness::Fresh) : std::nullopt;
        if (!entries) {
            r.summary = "quest list not readable (Player.Profile, Profile.QuestsData)";
            root["error"] = r.summary;
            r.json = root.dump();
            return r;
        }
        std::map<std::string, int> statuses;
        JsonList quests;
        for (Address e : *entries) {
            std::int32_t status = -1;
            if (!mem::MemoryView::isUserPointer(e) || !game_.mem.tryRead(e + off::QuestsData::Status, status, Freshness::Fresh))
                continue;
            ++statuses[statusName(status)];
            if (status != eft::kQuestStarted && status != eft::kQuestAvailableForFinish) continue;
            quests.push_back(quest(e, status));
            ++inProgress_;
        }
        Json st;
        for (const auto& [k, n] : statuses) st[k] = n;
        root["questsByStatus"] = std::move(st);
        root["quests"] = std::move(quests);
        root["counters"] = counters(profile);
        root["locale"] = locale();
        r.json = root.dump();

        std::string classes;
        for (const auto& [k, n] : classes_) classes += std::format("{}{} {}", classes.empty() ? "" : ", ", n, k);
        std::string types;
        for (const auto& [k, n] : types_) types += std::format("{}{} {}", types.empty() ? "" : ", ", n, k);
        r.summary = std::format(
            "{} quests in progress ({} in the profile), {} with a template: {} main/story, {} invisible, {} server-only\n"
            "quest types: {}\n{} conditions ({} item conditions): {}\n{} condition counters\n"
            "locale: {} entries, hash {}, {} of {} quest/trader names found",
            inProgress_, entries->size(), templates_, main_, invisible_, serverOnly_, types.empty() ? "-" : types,
            conditions_, itemConditions_, classes.empty() ? "-" : classes, counters_, localeEntries_,
            hashAlgo_.empty() ? "unknown" : hashAlgo_, namesFound_, wanted_.size());
        r.ok = templates_ > 0;
        return r;
    }

private:
    const eft::Game& game_;
    std::size_t inProgress_ = 0, templates_ = 0, main_ = 0, invisible_ = 0, serverOnly_ = 0;
    std::size_t conditions_ = 0, itemConditions_ = 0, counters_ = 0;
    std::map<std::string, int> classes_, types_;
    std::set<std::string> wanted_;  // locale keys to look up: quest names, trader nicknames
    std::size_t localeEntries_ = 0, namesFound_ = 0;
    std::string hashAlgo_;
};

}  // namespace

QuestProbeResult probeQuests(const eft::Game& game, Address localPlayer) { return Prober(game).run(localPlayer); }

}  // namespace radar::app
