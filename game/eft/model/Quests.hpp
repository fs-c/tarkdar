#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace radar::eft {

// EQuestStatus values the backend reports (the others: 0 Locked, 1 AvailableForStart, 4 Success,
// 5 Fail, 6 FailRestartable, 7 MarkedAsFailed, 8 Expired, 9 AvailableAfter, 10 AutoStart).
inline constexpr std::int32_t kQuestStarted = 2;
inline constexpr std::int32_t kQuestAvailableForFinish = 3;

// What kind of quest: the story (1.0 storyline chapters and their hidden steps), an ordinary trader
// quest, or a generated repeatable.
enum class QuestKind { Side, Story, Daily, Weekly };

// One of a quest's objectives for items, from its template (QuestTemplate.Conditions, the conditions
// to hand it in).
struct QuestObjective {
    enum class Type { Find, Handover, Plant };
    std::string id;                  // the condition id (what completed conditions and counters refer to)
    Type type = Type::Find;
    std::vector<std::string> items;  // template ids; any of them counts
    std::int32_t count = 1;
    bool foundInRaid = false;        // find / hand over only
    // Handed over so far (Profile.TaskConditionCounters); nullopt where the game keeps no counter
    // (find, plant) or none was read.
    std::optional<std::int32_t> progress{};
    std::string text{};              // English objective text, if the template has one
    friend bool operator==(const QuestObjective&, const QuestObjective&) = default;
};

// One of the local player's quests in progress (Profile.QuestsData → QuestStatusData).
struct QuestState {
    std::string id;          // the quest's id
    std::int32_t status = 0; // EQuestStatus: kQuestStarted or kQuestAvailableForFinish
    // Ids of the quest's conditions (objectives) already completed; nullopt if unreadable.
    std::optional<std::vector<std::string>> completedConditions{};
    // From the template (QuestStatusData.Template). `objectives` is nullopt if the template couldn't be
    // read; then nothing is known about what the quest needs.
    std::string name{};      // English name; empty if the template has none (repeatables, story steps)
    std::string traderId{};
    QuestKind kind = QuestKind::Side;
    bool hidden = false;     // QuestTemplate.IsInvisible: not shown in the quest list (hidden story steps)
    std::optional<std::vector<QuestObjective>> objectives{};
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
