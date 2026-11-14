#include "game/eft/world/Quests.hpp"

#include "core/mem/ReadBatch.hpp"
#include "game/eft/Read.hpp"

#include <eft_offsets.hpp>

#include <algorithm>
#include <array>
#include <cstring>
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

// EFT's MongoID struct as stored inline (in a HashSet slot): {u32 timestamp; u64 counter; String* stringId}.
struct InlineMongoId {
    std::array<std::byte, off::MongoID::StringId + sizeof(Address)> raw;
};

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

std::optional<std::vector<QuestState>> Quests::read() {
    const Address profile = readPointer(game_, session_->start.localPlayer + off::Player::Profile);
    const Address list = profile ? readPointer(game_, profile + off::Profile::QuestsData, Freshness::Fresh) : 0;
    if (!list) return std::nullopt;
    const auto entries = game_.managed.readList<Address>(list, kMaxQuests, Freshness::Fresh);
    if (!entries) return std::nullopt;

    std::vector<std::int32_t> statuses(entries->size(), 0);
    mem::ReadBatch batch(game_.mem);
    for (std::size_t i = 0; i < entries->size(); ++i) batch.add((*entries)[i] + off::QuestsData::Status, statuses[i]);
    batch.execute(Freshness::Fresh);

    std::vector<QuestState> out;
    for (std::size_t i = 0; i < entries->size(); ++i) {
        const Address entry = (*entries)[i];
        if (!mem::MemoryView::isUserPointer(entry) || !batch.complete(i)) continue;
        if (statuses[i] != kQuestStarted && statuses[i] != kQuestAvailableForFinish) continue;
        auto cached = ids_.find(entry);
        if (cached == ids_.end()) {
            auto id = game_.managed.readStringField(entry + off::QuestsData::Id, 64);
            if (!id || !looksLikeId(*id)) continue;
            cached = ids_.emplace(entry, std::move(*id)).first;
        }
        const Address set = readPointer(game_, entry + off::QuestsData::CompletedConditions, Freshness::Fresh);
        out.push_back({.id = cached->second, .status = statuses[i],
                       .completedConditions = set ? readConditions(set) : std::nullopt});
    }
    std::sort(out.begin(), out.end(), [](const auto& a, const auto& b) { return a.id < b.id; });
    return out;
}

std::optional<std::vector<std::string>> Quests::readConditions(Address set) {
    const auto valid = [](const std::vector<std::string>& ids) { return std::all_of(ids.begin(), ids.end(), looksLikeId); };
    // As on live EFT: HashSet<MongoID>.
    if (auto slots = game_.managed.readHashSet<InlineMongoId>(set, kMaxConditions, Freshness::Fresh)) {
        std::vector<std::string> ids;
        bool ok = true;
        for (const auto& m : *slots) {
            Address str = 0;
            std::memcpy(&str, m.raw.data() + off::MongoID::StringId, sizeof str);
            auto id = game_.managed.readString(str, 64);
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
