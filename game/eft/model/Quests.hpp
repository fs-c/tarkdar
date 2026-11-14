#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace radar::eft {

// EQuestStatus values the backend reports (the others: 0 Locked, 1 AvailableForStart, 4 Success,
// 5 Fail, 6 FailRestartable, 7 MarkedAsFailed, 8 Expired, 9 AvailableAfter).
inline constexpr std::int32_t kQuestStarted = 2;
inline constexpr std::int32_t kQuestAvailableForFinish = 3;

// One of the local player's quests in progress (Profile.QuestsData → QuestStatusData).
struct QuestState {
    std::string id;          // the quest's id (what quest names, objectives and items are looked up by)
    std::int32_t status = 0; // EQuestStatus: kQuestStarted or kQuestAvailableForFinish
    // Ids of the quest's conditions (objectives) already completed; nullopt if unreadable.
    std::optional<std::vector<std::string>> completedConditions{};
    friend bool operator==(const QuestState&, const QuestState&) = default;
};

struct QuestsSnapshot {
    std::uint64_t raidId = 0;
    std::uint64_t revision = 0;
    // False until the local player's quests were read once (the quest list is unknown, not empty).
    bool known = false;
    std::vector<QuestState> quests{};  // in progress only, ordered by id
};

}  // namespace radar::eft
