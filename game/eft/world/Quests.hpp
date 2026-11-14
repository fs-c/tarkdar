#pragma once

#include "game/eft/model/WorldState.hpp"
#include "game/eft/raid/RaidSession.hpp"

#include <memory>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace radar::eft {

// The local player's quests in progress. Publishes WorldState::quests.
//
// localPlayer → Profile → QuestsData, a List<QuestStatusData>: one entry per quest the profile has a
// status for (hundreds, most of them finished long ago). Only quests that are started or ready to hand
// in are reported, with their completed condition ids (QuestStatusData.CompletedConditions, a
// HashSet). Quest ids never change for an entry, so they're cached by entry address.
//
// Unverified on SPT: whether CompletedConditions holds MongoIDs (inline structs, as on live EFT per
// the reference implementation) or strings. Both are tried; elements must look like ids.
class Quests final : public RaidSubsystem {
public:
    static constexpr auto kInterval = std::chrono::seconds(2);
    // QuestsData entries read at most (the game has a few hundred quests).
    static constexpr std::size_t kMaxQuests = 4096;
    static constexpr std::size_t kMaxConditions = 256;

    Quests(std::shared_ptr<const RaidSession> session, WorldState& world);
    ~Quests() override;

    void registerTasks(sched::TaskRunner& live, sched::TaskRunner& background) override;

    void update();

private:
    // The quest list; nullopt if it couldn't be read.
    [[nodiscard]] std::optional<std::vector<QuestState>> read();
    [[nodiscard]] std::optional<std::vector<std::string>> readConditions(Address set);

    std::shared_ptr<const RaidSession> session_;
    const Game& game_;
    WorldState& world_;
    std::unordered_map<Address, std::string> ids_;  // QuestStatusData → quest id
    std::optional<std::vector<QuestState>> last_;
    std::uint64_t revision_ = 0;
};

}  // namespace radar::eft
