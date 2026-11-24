#pragma once

#include "game/eft/model/WorldState.hpp"
#include "game/eft/raid/RaidSession.hpp"

#include <memory>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace radar::eft {

// The local player's quests in progress, with what they need. Publishes WorldState::quests.
//
// localPlayer → Profile → QuestsData, a List<QuestStatusData>: one entry per quest the profile has a
// status for (hundreds, most of them finished long ago). Only quests that are started or ready to hand
// in are reported, with
//  - their completed condition ids (QuestStatusData.CompletedConditions, a HashSet),
//  - from their template (QuestStatusData.Template, read once per entry: templates don't change): the
//    trader, kind (story, side, daily, weekly) and item objectives (find, hand over, plant:
//    QuestTemplate.Conditions, the conditions to hand the quest in),
//  - their name and objective texts from the game's text table, in the player's language
//    (Locale.hpp: "<quest id> name", the condition ids),
//  - hand-over progress from the profile's condition counters (Profile.TaskConditionCounters, keyed
//    by condition id).
// Verified on SPT (2026-11-20, with a throwaway probe of the quest templates; texts 2026-11-21:
// radar-diagnose found the text table has every text the templates' own dictionaries have, the same).
class Quests final : public RaidSubsystem {
public:
    static constexpr auto kInterval = std::chrono::seconds(2);
    // QuestsData entries read at most (the game has a few hundred quests).
    static constexpr std::size_t kMaxQuests = 4096;
    static constexpr std::size_t kMaxConditions = 256;
    static constexpr std::size_t kMaxCounters = 16384;
    static constexpr std::size_t kMaxTargets = 512;
    // A template that can't be read is tried again this many times (it may not be filled in yet).
    static constexpr int kTemplateAttempts = 5;
    // A quest without texts is looked for this many times (the text table may not be readable yet;
    // some quests have no texts at all).
    static constexpr int kTextAttempts = 5;
    // Repeatables that run longer than this are weeklies (dailies: 24 h, weeklies: 7 days).
    static constexpr std::int32_t kWeeklyAfterSeconds = 2 * 24 * 3600;

    Quests(std::shared_ptr<const RaidSession> session, WorldState& world);
    ~Quests() override;

    void registerTasks(sched::TaskRunner& live, sched::TaskRunner& background) override;

    void update();

    // For radar-diagnose: whether quests not started yet could be shown (TODO.md, future quests).
    // Per status in QuestsData (EQuestStatus: 0 locked, 1 available to start, 2 started, 3 ready to
    // hand in, 4 done, 5 failed, ...): how many entries, and for a sample of them whether the template
    // reads and has item objectives. Unverified: whether locked quests are in QuestsData at all.
    struct StatusSurvey {
        std::int32_t status = 0;
        std::size_t entries = 0, sampled = 0, withTemplate = 0, withItems = 0;
        std::vector<std::string> examples{};  // "<id> <name>: N item objectives"
    };
    [[nodiscard]] std::optional<std::vector<StatusSurvey>> surveyStatuses(std::size_t samplePerStatus = 8);

private:
    // What the template says (everything of QuestState but status, completed conditions and progress).
    struct Template {
        std::string name{}, traderId{};
        QuestKind kind = QuestKind::Side;
        bool hidden = false;
        std::vector<QuestObjective> objectives{};
    };
    struct Entry {
        std::string id{};
        std::optional<Template> tmpl{};
        int attempts = 0;
        bool texted = false;  // has a name or an objective text
        int textAttempts = 0;
    };

    // The quest list; nullopt if it couldn't be read. What a failed read within it leaves unknown (a
    // quest's status, its completed conditions, hand-over progress) is carried over from last_; the
    // failures are counted in failures_.
    [[nodiscard]] std::optional<std::vector<QuestState>> read();
    [[nodiscard]] std::optional<std::vector<std::string>> readConditions(Address set);
    // Everything but the texts (lookUpTexts).
    [[nodiscard]] std::optional<Template> readTemplate(Address statusData);
    [[nodiscard]] std::optional<std::vector<QuestObjective>> readObjectives(Address conditionsDict);
    // Fills in the name and objective texts of templates that have none yet, in one text-table scan.
    void lookUpTexts(const std::vector<Entry*>& entries);
    struct Counters {
        std::unordered_map<std::string, std::int32_t> values;  // condition id → counter value
        bool complete = true;                                  // false: some counters didn't read
    };
    // Nullopt if the dictionary is unreadable; counters that don't read are left out (complete = false).
    [[nodiscard]] std::optional<Counters> readCounters(Address profile);
    // Logs what changed against last_.
    void logChange(const std::vector<QuestState>& now) const;
    [[nodiscard]] bool isA(Address object, std::string_view className);

    std::shared_ptr<const RaidSession> session_;
    const Game& game_;
    WorldState& world_;
    std::unordered_map<Address, Entry> entries_;          // QuestStatusData → id and template
    std::unordered_map<Address, std::string> counterIds_;  // MongoID string → condition id
    std::optional<std::vector<QuestState>> last_;
    std::uint64_t revision_ = 0;
    std::size_t failures_ = 0;  // of the last read()
};

}  // namespace radar::eft
