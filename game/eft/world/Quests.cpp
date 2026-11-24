#include "game/eft/world/Quests.hpp"

#include "core/log/Log.hpp"
#include "core/mem/ReadBatch.hpp"
#include "game/eft/Locale.hpp"
#include "game/eft/Names.hpp"
#include "game/eft/Read.hpp"

#include <eft_offsets.hpp>

#include <algorithm>
#include <cstddef>
#include <format>
#include <iterator>
#include <map>

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
    if (!quests) return;  // an unreadable list keeps the last good one
    if (failures_ > 0)
        log::debug("quests: {} read(s) failed; their quests, conditions or progress carried over from the last read",
                   failures_);
    if (quests == last_) return;
    logChange(*quests);
    last_ = std::move(quests);
    world_.quests.publish(QuestsSnapshot{.raidId = session_->id, .revision = ++revision_, .known = true, .quests = *last_});
}

void Quests::logChange(const std::vector<QuestState>& now) const {
    // Rare (a quest started, handed in, a condition done): worth a line, and it shows when quests
    // disappear and come back.
    std::vector<std::string> added, removed;
    const auto ids = [](const std::vector<QuestState>& qs) {
        std::vector<std::string> out;
        for (const auto& q : qs) out.push_back(q.id);
        return out;  // sorted: read() sorts by id
    };
    const auto before = last_ ? ids(*last_) : std::vector<std::string>{};
    const auto after = ids(now);
    std::set_difference(after.begin(), after.end(), before.begin(), before.end(), std::back_inserter(added));
    std::set_difference(before.begin(), before.end(), after.begin(), after.end(), std::back_inserter(removed));
    const auto list = [](const std::vector<std::string>& v) {
        std::string out;
        for (std::size_t i = 0; i < v.size() && i < 5; ++i) out += (i ? ", " : "") + v[i];
        return v.size() > 5 ? out + std::format(", … ({} more)", v.size() - 5) : out;
    };
    log::info("quests: {} in progress{}{}{}", now.size(), added.empty() || !last_ ? "" : "; started " + list(added),
              removed.empty() ? "" : "; gone " + list(removed),
              added.empty() && removed.empty() && last_ ? "; progress changed" : "");
}

bool Quests::isA(Address object, std::string_view className) { return game_.managed.isInstanceOf(object, className); }

std::optional<std::vector<QuestState>> Quests::read() {
    failures_ = 0;
    const Address profile = readPointer(game_, session_->start.localPlayer + off::Player::Profile);
    const Address list = profile ? readPointer(game_, profile + off::Profile::QuestsData, Freshness::Fresh) : 0;
    if (!list) return std::nullopt;
    const auto entries = game_.managed.readList<Address>(list, kMaxQuests, Freshness::Fresh);
    if (!entries) return std::nullopt;

    // What a failed read leaves unknown is taken from the last read: memory that doesn't read for a
    // moment mustn't drop quests (they'd come back as new) or progress (items would look needed again).
    std::unordered_map<std::string_view, const QuestState*> previous;
    if (last_)
        for (const auto& q : *last_) previous.emplace(q.id, &q);
    const auto previousOf = [&](const std::string& id) -> const QuestState* {
        const auto it = previous.find(id);
        return it != previous.end() ? it->second : nullptr;
    };

    const auto statuses = mem::readEach<std::int32_t>(game_.mem, *entries, off::QuestsData::Status, Freshness::Fresh);

    struct Active {
        Address address;
        std::int32_t status;
        Entry* entry;
    };
    std::vector<Active> active;
    std::vector<QuestState> out;
    for (std::size_t i = 0; i < entries->size(); ++i) {
        const Address address = (*entries)[i];
        if (!mem::MemoryView::isUserPointer(address)) continue;
        auto cached = entries_.find(address);
        if (!statuses[i]) {
            ++failures_;
            if (cached != entries_.end())
                if (const auto* p = previousOf(cached->second.id)) out.push_back(*p);
            continue;
        }
        if (*statuses[i] != kQuestStarted && *statuses[i] != kQuestAvailableForFinish) continue;
        if (cached == entries_.end()) {
            auto id = game_.managed.readStringField(address + off::QuestsData::Id, 64);
            if (!id || !looksLikeId(*id)) {
                ++failures_;
                continue;
            }
            cached = entries_.emplace(address, Entry{.id = std::move(*id)}).first;
        }
        Entry& entry = cached->second;
        if (!entry.tmpl && entry.attempts < kTemplateAttempts) {
            ++entry.attempts;
            entry.tmpl = readTemplate(address);
        }
        active.push_back({address, *statuses[i], &entry});
    }
    std::vector<Entry*> seen;
    for (const auto& a : active) seen.push_back(a.entry);
    lookUpTexts(seen);

    std::optional<std::optional<Counters>> counters;  // read when first needed
    for (const auto& [address, status, entry] : active) {
        const QuestState* prev = previousOf(entry->id);
        Address set = 0;
        std::optional<std::vector<std::string>> completed;
        if (!game_.mem.tryRead(address + off::QuestsData::CompletedConditions, set, Freshness::Fresh)) {
            ++failures_;
            if (prev) completed = prev->completedConditions;
        } else if (set) {
            completed = readConditions(set);
            if (!completed && prev) completed = prev->completedConditions;  // nullopt too if it never read
        }
        QuestState q{.id = entry->id, .status = status, .completedConditions = std::move(completed)};
        if (entry->tmpl) {
            q.name = entry->tmpl->name;
            q.traderId = entry->tmpl->traderId;
            q.kind = entry->tmpl->kind;
            q.hidden = entry->tmpl->hidden;
            q.objectives = entry->tmpl->objectives;
            for (auto& o : *q.objectives) {
                if (o.type != QuestObjective::Type::Handover) continue;
                if (!counters) {
                    counters = readCounters(profile);
                    if (!*counters || !(*counters)->complete) ++failures_;
                }
                const Counters* read = *counters ? &**counters : nullptr;
                if (read)
                    if (const auto c = read->values.find(o.id); c != read->values.end()) {
                        o.progress = c->second;
                        continue;
                    }
                // No counter: not started yet, unless counters didn't read; then the last known progress.
                if ((!read || !read->complete) && prev && prev->objectives)
                    for (const auto& po : *prev->objectives)
                        if (po.id == o.id) o.progress = po.progress;
            }
        }
        out.push_back(std::move(q));
    }
    std::sort(out.begin(), out.end(), [](const auto& a, const auto& b) { return a.id < b.id; });
    return out;
}

void Quests::lookUpTexts(const std::vector<Entry*>& entries) {
    // The game's text table holds "<quest id> name" and each condition's text under its id, in the
    // player's language. Some quests have none (story steps, SPT's dailies): looked for a few times.
    std::vector<Entry*> pending;
    std::vector<std::string> keys;
    for (Entry* e : entries) {
        if (!e->tmpl || e->texted || e->textAttempts >= kTextAttempts) continue;
        ++e->textAttempts;
        pending.push_back(e);
        keys.push_back(e->id + " name");
        for (const auto& o : e->tmpl->objectives) keys.push_back(o.id);
    }
    if (pending.empty()) return;
    const auto texts = lookupTexts(game_, keys);
    for (Entry* e : pending) {
        if (auto n = texts.find(e->id + " name"); n != texts.end()) e->tmpl->name = n->second;
        e->texted = !e->tmpl->name.empty();
        for (auto& o : e->tmpl->objectives) {
            if (auto x = texts.find(o.id); x != texts.end()) o.text = x->second;
            e->texted |= !o.text.empty();
        }
    }
}

std::optional<std::vector<Quests::StatusSurvey>> Quests::surveyStatuses(std::size_t samplePerStatus) {
    const Address profile = readPointer(game_, session_->start.localPlayer + off::Player::Profile);
    const Address list = profile ? readPointer(game_, profile + off::Profile::QuestsData, Freshness::Fresh) : 0;
    if (!list) return std::nullopt;
    const auto entries = game_.managed.readList<Address>(list, kMaxQuests, Freshness::Fresh);
    if (!entries) return std::nullopt;
    const auto statuses = mem::readEach<std::int32_t>(game_.mem, *entries, off::QuestsData::Status, Freshness::Fresh);

    std::map<std::int32_t, StatusSurvey> by;  // node-based: the pointers below stay valid
    struct Sampled {
        StatusSurvey* survey;
        std::string id;
        std::size_t objectives;
    };
    std::vector<Sampled> sampled;
    std::vector<std::string> nameKeys;
    for (std::size_t i = 0; i < entries->size(); ++i) {
        const Address address = (*entries)[i];
        if (!mem::MemoryView::isUserPointer(address) || !statuses[i]) continue;
        StatusSurvey& s = by[*statuses[i]];
        s.status = *statuses[i];
        ++s.entries;
        if (s.sampled >= samplePerStatus) continue;
        ++s.sampled;
        const auto id = game_.managed.readStringField(address + off::QuestsData::Id, 64).value_or("?");
        const auto t = readTemplate(address);
        if (!t) {
            s.examples.push_back(std::format("{}: no template", id));
            continue;
        }
        ++s.withTemplate;
        s.withItems += !t->objectives.empty();
        sampled.push_back({&s, id, t->objectives.size()});
        nameKeys.push_back(id + " name");
    }
    const auto names = lookupTexts(game_, nameKeys);
    for (const auto& [s, id, objectives] : sampled) {
        const auto n = names.find(id + " name");
        s->examples.push_back(std::format("{} {}: {} item objectives", id, n != names.end() ? n->second : "(unnamed)", objectives));
    }
    std::vector<StatusSurvey> out;
    for (auto& [_, s] : by) out.push_back(std::move(s));
    return out;
}

std::optional<Quests::Template> Quests::readTemplate(Address statusData) {
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

std::optional<Quests::Counters> Quests::readCounters(Address profile) {
    // Dictionary<MongoID, TaskConditionCounter>: the key is the condition's id.
    Counters out;
    const Address dict = readPointer(game_, profile + off::Profile::TaskConditionCounters, Freshness::Fresh);
    const auto entries = dict ? game_.managed.readDictionary<MongoId, Address>(dict, kMaxCounters, Freshness::Fresh)
                              : std::nullopt;
    if (!entries) return std::nullopt;
    std::vector<Address> counters;
    counters.reserve(entries->size());
    for (const auto& entry : *entries) counters.push_back(entry.second);
    const auto values = mem::readEach<std::int32_t>(game_.mem, counters, off::TaskConditionCounter::Value, Freshness::Fresh);
    for (std::size_t i = 0; i < entries->size(); ++i) {
        const Address str = (*entries)[i].first.stringId;
        if (!values[i] || !mem::MemoryView::isUserPointer(str)) {
            out.complete = false;
            continue;
        }
        auto cached = counterIds_.find(str);
        if (cached == counterIds_.end()) {
            auto id = game_.managed.readString(str, 64);
            if (!id) {
                out.complete = false;
                continue;
            }
            cached = counterIds_.emplace(str, std::move(*id)).first;
        }
        out.values[cached->second] = *values[i];
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
