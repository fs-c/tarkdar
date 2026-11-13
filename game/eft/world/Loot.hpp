#pragma once

#include "game/eft/model/WorldState.hpp"
#include "game/eft/raid/RaidSession.hpp"

#include <memory>
#include <unordered_map>
#include <unordered_set>

namespace radar::eft {

// Loot on the map: loose items, quest items, containers, airdrops and corpses, from the GameWorld's
// LootList. Publishes WorldState::loot.
//
// - Scan (every kScanInterval): reads the whole LootList. New entries become pending; entries
//   missing from kMissesToRemove consecutive scans are removed, unless the list suddenly shrank to
//   less than half the cache (a torn read), in which case nothing is removed that scan.
// - Resolve (every kResolveInterval, at most kResolvePerTick entries): classifies pending entries by
//   runtime class (Corpse, LootableContainer, LootItem, or subclasses; anything else is ignored),
//   reads the template id and the position. Failures are retried with back-off.
// - Positions are read once, except airdrops (they fall), which are re-read every scan.
//
// - Corpses get their equipment (item trees). Read at resolve time and refreshed for
//   kContentRefreshPerScan corpses per scan, round-robin (equipment changes when looted). Container
//   contents aren't read: that turned out to be infeasible.
// - Address reuse: each scan re-reads every entry's class pointer; an entry whose class changed is
//   dropped and resolved again (the address now belongs to a different object).
class Loot final : public RaidSubsystem {
public:
    static constexpr auto kScanInterval = std::chrono::seconds(3);
    static constexpr auto kResolveInterval = std::chrono::milliseconds(250);
    static constexpr std::size_t kResolvePerTick = 256;
    static constexpr std::size_t kMaxEntries = 12000;
    static constexpr int kMissesToRemove = 2;
    static constexpr int kMaxAttempts = 10;
    static constexpr std::size_t kContentRefreshPerScan = 16;

    Loot(std::shared_ptr<const RaidSession> session, WorldState& world);
    ~Loot() override;

    void registerTasks(sched::TaskRunner& live, sched::TaskRunner& background) override;

    void scan(sched::Clock::time_point now);
    void resolve(sched::Clock::time_point now);

private:
    struct Entry {
        LootEntry loot;
        Address transform = 0;
        Address contentsRoot = 0;  // corpse equipment root
        Address klass = 0;         // runtime class at resolve time; a change means the address was reused
        int misses = 0;
    };
    struct Failure {
        int attempts = 0;
        sched::Clock::time_point nextTry{};
        bool permanent = false;
    };
    struct Resolved {
        Address instance = 0;
        Entry entry;
    };

    // Classifies and reads one entry (everything but the position). nullopt = failed; sets permanent
    // when retrying can't help.
    std::optional<Resolved> resolveOne(Address instance, bool& permanent) const;
    void refreshAirdrops();
    void refreshContents();
    std::vector<ItemNode> readContents(const Entry& e) const;
    void publish();

    std::shared_ptr<const RaidSession> session_;
    const Game& game_;
    WorldState& world_;
    std::unordered_map<Address, Entry> entries_;
    std::unordered_set<Address> live_;     // entries in the last scan
    std::unordered_set<Address> pending_;  // in the list, not resolved yet
    std::unordered_map<Address, Failure> failures_;
    std::uint32_t nextId_ = 1;
    std::uint64_t revision_ = 0;
    bool dirty_ = false;
    std::size_t contentCursor_ = 0;
};

}  // namespace radar::eft
