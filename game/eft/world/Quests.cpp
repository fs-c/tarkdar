#include "game/eft/world/Quests.hpp"

#include "core/mem/ReadBatch.hpp"
#include "game/eft/Names.hpp"
#include "game/eft/Read.hpp"

#include <eft_offsets.hpp>

#include <algorithm>
#include <cstddef>

namespace radar::eft {

using mem::Freshness;

namespace {

// Quest and condition ids are MongoIDs (24 hex digits); custom (modded) quests may use other names.
bool looksLikeId(const std::string& s) {
    return !s.empty() && s.size() <= 64 && std::all_of(s.begin(), s.end(), [](char c) {
        return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_' || c == '-';
    });
}

// EFT's MongoID struct as stored inline (in a HashSet slot or Dictionary key).
struct MongoId {
    std::uint32_t timestamp;
    std::uint64_t counter;
    Address stringId;
};
static_assert(offsetof(MongoId, stringId) == off::MongoID::StringId);
static_assert(sizeof(MongoId) == off::MongoID::StringId + sizeof(Address));

}  // namespace

Quests::Quests(std::shared_ptr<const RaidSession> session, WorldState& world)
    : session_(std::move(session)), game_(session_->game), world_(world) {}

Quests::~Quests() { world_.quests.publish(QuestsSnapshot{}); }

void Quests::registerTasks(sched::TaskRunner&, sched::TaskRunner& background) {
    background.add("quests", {.interval = kInterval, .phase = std::chrono::milliseconds(700)}, [this] { update(); });
}

void Quests::update() {
    auto quests = read();
    if (!quests || quests == last_) return;  // an unreadable list keeps the last good one
    last_ = std::move(quests);
    world_.quests.publish(QuestsSnapshot{.raidId = session_->id, .revision = ++revision_, .known = true, .quests = *last_});
}

bool Quests::isA(Address object, std::string_view className) { return game_.managed.isInstanceOf(object, className); }

std::optional<std::vector<QuestState>> Quests::read() {
    const Address profile = readPointer(game_, session_->start.localPlayer + off::Player::Profile);
    const Address list = profile ? readPointer(game_, profile + off::Profile::QuestsData, Freshness::Fresh) : 0;
    if (!list) return std::nullopt;
    const auto entries = game_.managed.readList<Address>(list, kMaxQuests, Freshness::Fresh);
    if (!entries) return std::nullopt;

    const auto statuses = mem::readEach<std::int32_t>(game_.mem, *entries, off::QuestsData::Status, Freshness::Fresh);

    std::optional<std::unordered_map<std::string, std::int32_t>> counters;  // read when first needed
    std::vector<QuestState> out;
    for (std::size_t i = 0; i < entries->size(); ++i) {
        const Address address = (*entries)[i];
        if (!mem::MemoryView::isUserPointer(address) || !statuses[i]) continue;
        if (*statuses[i] != kQuestStarted && *statuses[i] != kQuestAvailableForFinish) continue;
        auto cached = entries_.find(address);
        if (cached == entries_.end()) {
            auto id = game_.managed.readStringField(address + off::QuestsData::Id, 64);
            if (!id || !looksLikeId(*id)) continue;
            cached = entries_.emplace(address, Entry{.id = std::move(*id)}).first;
        }
        Entry& entry = cached->second;
        if (!entry.tmpl && entry.attempts < kTemplateAttempts) {
            ++entry.attempts;
            entry.tmpl = readTemplate(address, entry.id);
        }
        const Address set = readPointer(game_, address + off::QuestsData::CompletedConditions, Freshness::Fresh);
        auto completed = set ? readConditions(set) : std::nullopt;
        QuestState q{.id = entry.id, .status = *statuses[i], .completedConditions = std::move(completed)};
        if (entry.tmpl) {
            q.name = entry.tmpl->name;
            q.traderId = entry.tmpl->traderId;
            q.kind = entry.tmpl->kind;
            q.hidden = entry.tmpl->hidden;
            q.objectives = entry.tmpl->objectives;
            for (auto& o : *q.objectives) {
                if (o.type != QuestObjective::Type::Handover) continue;
                if (!counters) counters = readCounters(profile);
                if (auto c = counters->find(o.id); c != counters->end()) o.progress = c->second;
            }
        }
        out.push_back(std::move(q));
    }
    std::sort(out.begin(), out.end(), [](const auto& a, const auto& b) { return a.id < b.id; });
    return out;
}

std::optional<Quests::Template> Quests::readTemplate(Address statusData, const std::string& questId) {
    const Address t = readPointer(game_, statusData + off::QuestsData::Template);
    if (!t) return std::nullopt;
    const Address conditions = readPointer(game_, t + off::QuestTemplate::Conditions);
    auto objectives = conditions ? readObjectives(conditions) : std::nullopt;
    if (!objectives) return std::nullopt;

    Template out{.objectives = std::move(*objectives)};
    out.traderId = game_.managed.readStringField(t + off::QuestTemplate::TraderId, 64).value_or("");
    bool main = false, invisible = false;
    game_.mem.tryRead(t + off::QuestTemplate::IsMainQuest, main);
    game_.mem.tryRead(t + off::QuestTemplate::IsInvisible, invisible);
    out.hidden = invisible;
    if (main || out.traderId == kStoryTraderId) {
        out.kind = QuestKind::Story;
    } else if (isA(t, kRepeatableQuestTemplateClass)) {
        std::int32_t start = 0, expiration = 0;
        game_.mem.tryRead(statusData + off::QuestsData::StartTime, start);
        game_.mem.tryRead(t + off::RepeatableQuestTemplate::ExpirationTime, expiration);
        out.kind = expiration - start > kWeeklyAfterSeconds ? QuestKind::Weekly : QuestKind::Daily;
    }

    // TODO(quest-locale): quest text has its own reader (readTexts: the template's per-language
    // dictionaries, English only), while exfil names come from the game's global text table in the
    // player's language (Locale.hpp, lookupTexts). If that table also holds "<quest id> name" and
    // the condition ids, look them up there and drop readTexts, QuestTemplate::Localization and
    // kQuestLanguage. Needs checking against the running game.
    if (const Address localization = readPointer(game_, t + off::QuestTemplate::Localization)) {
        const auto texts = readTexts(localization);
        if (auto n = texts.find(questId + " name"); n != texts.end()) out.name = n->second;
        for (auto& o : out.objectives)
            if (auto x = texts.find(o.id); x != texts.end()) o.text = x->second;
    }
    return out;
}

std::optional<std::vector<QuestObjective>> Quests::readObjectives(Address conditionsDict) {
    // ConditionsDict: Dictionary<EQuestStatus, ConditionCollection>; the objectives are the conditions to
    // hand the quest in. ConditionCollection is a BindableList: its items are in a List<Condition>.
    // (Item conditions nested in others only refer back to top-level ones.)
    const auto statuses = game_.managed.readDictionary<std::int32_t, Address>(conditionsDict, 32);
    if (!statuses) return std::nullopt;
    std::vector<QuestObjective> out;
    for (const auto& [status, collection] : *statuses) {
        if (status != kQuestAvailableForFinish) continue;
        const Address list = readPointer(game_, collection + off::BindableList::List);
        const auto conditions = list ? game_.managed.readList<Address>(list, kMaxConditions) : std::nullopt;
        if (!conditions) return std::nullopt;
        for (const Address c : *conditions) {
            if (!mem::MemoryView::isUserPointer(c)) continue;
            QuestObjective o;
            if (isA(c, kConditionFindItemClass)) o.type = QuestObjective::Type::Find;
            else if (isA(c, kConditionHandoverItemClass)) o.type = QuestObjective::Type::Handover;
            else if (isA(c, kConditionLeaveItemClass)) o.type = QuestObjective::Type::Plant;
            else continue;
            auto id = readMongoId(game_, c + off::QuestCondition::Id);
            const Address targets = readPointer(game_, c + off::ConditionMultipleTargets::Target);
            const auto strings = targets ? game_.managed.readArray<Address>(targets, kMaxTargets) : std::nullopt;
            if (!id || !strings) continue;
            o.id = std::move(*id);
            for (const Address s : *strings)
                if (auto tpl = game_.managed.readString(s, 64); tpl && !tpl->empty()) o.items.push_back(std::move(*tpl));
            float value = 1;
            game_.mem.tryRead(c + off::QuestCondition::Value, value);
            o.count = value >= 1 && value < 2e9f ? static_cast<std::int32_t>(value + 0.5f) : 1;
            if (isA(c, kConditionItemClass)) game_.mem.tryRead(c + off::ConditionItem::OnlyFoundInRaid, o.foundInRaid);
            out.push_back(std::move(o));
        }
    }
    return out;
}

std::unordered_map<std::string, std::string> Quests::readTexts(Address localization) {
    // Dictionary<language, Dictionary<key, text>>; keys are "<quest id> name", condition ids, ….
    std::unordered_map<std::string, std::string> out;
    const auto languages = game_.managed.readDictionary<Address, Address>(localization, 64);
    if (!languages) return out;
    for (const auto& [language, texts] : *languages) {
        if (game_.managed.readString(language, 16) != kQuestLanguage) continue;
        const auto entries = game_.managed.readDictionary<Address, Address>(texts, 1024);
        if (!entries) break;
        for (const auto& [key, text] : *entries) {
            auto k = game_.managed.readString(key, 128);
            auto v = game_.managed.readString(text, 512, il2cpp::Managed::Overflow::Truncate);
            if (k && v && !v->empty()) out.emplace(std::move(*k), std::move(*v));
        }
        break;
    }
    return out;
}

std::unordered_map<std::string, std::int32_t> Quests::readCounters(Address profile) {
    // Dictionary<MongoID, TaskConditionCounter>: the key is the condition's id.
    std::unordered_map<std::string, std::int32_t> out;
    const Address dict = readPointer(game_, profile + off::Profile::TaskConditionCounters, Freshness::Fresh);
    const auto entries = dict ? game_.managed.readDictionary<MongoId, Address>(dict, kMaxCounters, Freshness::Fresh)
                              : std::nullopt;
    if (!entries) return out;
    std::vector<Address> counters;
    counters.reserve(entries->size());
    for (const auto& entry : *entries) counters.push_back(entry.second);
    const auto values = mem::readEach<std::int32_t>(game_.mem, counters, off::TaskConditionCounter::Value, Freshness::Fresh);
    for (std::size_t i = 0; i < entries->size(); ++i) {
        const Address str = (*entries)[i].first.stringId;
        if (!values[i] || !mem::MemoryView::isUserPointer(str)) continue;
        auto cached = counterIds_.find(str);
        if (cached == counterIds_.end()) {
            auto id = game_.managed.readString(str, 64);
            if (!id) continue;
            cached = counterIds_.emplace(str, std::move(*id)).first;
        }
        out[cached->second] = *values[i];
    }
    return out;
}

std::optional<std::vector<std::string>> Quests::readConditions(Address set) {
    const auto valid = [](const std::vector<std::string>& ids) { return std::all_of(ids.begin(), ids.end(), looksLikeId); };
    // As on live EFT: HashSet<MongoID>.
    if (auto slots = game_.managed.readHashSet<MongoId>(set, kMaxConditions, Freshness::Fresh)) {
        std::vector<std::string> ids;
        bool ok = true;
        for (const auto& m : *slots) {
            auto id = game_.managed.readString(m.stringId, 64);
            if (!id) { ok = false; break; }
            ids.push_back(std::move(*id));
        }
        if (ok && valid(ids)) {
            std::sort(ids.begin(), ids.end());
            return ids;
        }
    }
    // Otherwise HashSet<string>.
    if (auto slots = game_.managed.readHashSet<Address>(set, kMaxConditions, Freshness::Fresh)) {
        std::vector<std::string> ids;
        for (const Address str : *slots) {
            auto id = game_.managed.readString(str, 64);
            if (!id) return std::nullopt;
            ids.push_back(std::move(*id));
        }
        if (valid(ids)) {
            std::sort(ids.begin(), ids.end());
            return ids;
        }
    }
    return std::nullopt;
}

}  // namespace radar::eft
