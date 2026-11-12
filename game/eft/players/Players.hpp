#pragma once

#include "core/math/Math.hpp"
#include "core/sched/TaskRunner.hpp"
#include "core/sched/Published.hpp"
#include "game/eft/model/WorldState.hpp"
#include "game/eft/players/PlayerKinds.hpp"
#include "game/eft/players/Skeleton.hpp"
#include "game/eft/raid/RaidSession.hpp"

#include <memory>
#include <optional>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace radar::eft {

// Tracks the raid's players and publishes WorldState::players.
//
// Two tasks on the live thread (so internal state needs no locking):
//  - roster (kRosterInterval): diffs the registered-player list, builds new players, refreshes
//    rotation and death state, tracks players that left the list;
//  - positions (kPositionInterval): reads every alive player's skeleton joints in one batch.
// Plus one task on the background thread:
//  - equipment (kEquipmentInterval): reads up to kEquipmentPerTick players' equipment trees, each
//    player at most every kEquipmentRefresh, and publishes WorldState::equipment. It sees the roster
//    only through an internally published list, so it shares no mutable state with the live tasks.
//
// Both player layouts are tracked (full EFT.Player and network-replicated ObservedPlayerView, see
// game/eft/players/PlayerKinds.hpp): the build resolves per-kind field addresses, everything after
// that is shared.
class Players final : public RaidSubsystem {
public:
    static constexpr auto kRosterInterval = std::chrono::milliseconds(20);
    static constexpr auto kPositionInterval = std::chrono::milliseconds(10);
    static constexpr int kMaxBuildsPerTick = 4;
    // An observed player's role (its AI data) may be set up after it's registered: re-read it this
    // often, this many times (~10 s), before giving up.
    static constexpr auto kRoleRetry = std::chrono::milliseconds(500);
    static constexpr int kMaxRoleAttempts = 20;
    // A player that fails to build is retried freely kMaxFreeBuildAttempts times, then every kBuildRetry.
    static constexpr int kMaxFreeBuildAttempts = 5;
    static constexpr auto kBuildRetry = std::chrono::seconds(2);
    static constexpr auto kMinBuildSpacing = std::chrono::milliseconds(200);  // between free retries
    static constexpr auto kCorpseInterval = std::chrono::milliseconds(100);
    static constexpr auto kBoneRetry = std::chrono::seconds(1);
    // Absent from the list for at least this many roster ticks and this long → "absent".
    static constexpr int kAbsentMisses = 3;
    static constexpr auto kAbsentAfter = std::chrono::seconds(2);
    static constexpr auto kEquipmentInterval = std::chrono::milliseconds(500);
    static constexpr auto kEquipmentRefresh = std::chrono::seconds(5);
    static constexpr std::size_t kEquipmentPerTick = 2;

    Players(std::shared_ptr<const RaidSession> session, WorldState& world);
    ~Players() override;

    void registerTasks(sched::TaskRunner& live, sched::TaskRunner& background) override;

    // Task bodies; public for tests, which drive them with synthetic times.
    void rosterTick(sched::Clock::time_point now);
    void positionsTick(sched::Clock::time_point now);
    void equipmentTick(sched::Clock::time_point now);

    // Registered entries that haven't built (yet), with the last failure reason. For --diagnose.
    struct BuildFailureInfo {
        Address instance = 0;
        std::string className;
        std::string error;
        int attempts = 0;
    };
    [[nodiscard]] std::vector<BuildFailureInfo> buildFailures() const;

private:
    struct Entry {
        std::uint32_t id = 0;
        Address instance = 0;
        bool local = false;
        PlayerLayout layout;  // kind, identity and field addresses, resolved at build time
        // Observed players: re-reads of a role missing at build time.
        int roleAttempts = 0;
        sched::Clock::time_point nextRoleRead{};
        // Dynamic state.
        float yaw = 0, pitch = 0;
        bool dead = false;
        sched::Clock::time_point nextCorpseCheck{};
        std::optional<SkeletonBones> bones;
        sched::Clock::time_point nextBoneResolve{};
        std::optional<math::Vec3> position;
        std::optional<Joints> joints;
        // Absence tracking.
        int misses = 0;
        std::optional<sched::Clock::time_point> missingSince;
        bool absent = false;
    };
    struct BuildFailure {
        int attempts = 0;
        sched::Clock::time_point last{};
        std::string className;
        std::string error;
    };

    // What the equipment task needs to know about a player.
    struct Ref {
        std::uint32_t id = 0;
        Address inventoryControllerField = 0;
        bool dead = false;
        friend bool operator==(const Ref&, const Ref&) = default;
    };
    struct EquipmentState {
        sched::Clock::time_point lastRead{};
        bool read = false;
        std::vector<ItemNode> slots;
    };

    void publishRefs();
    std::vector<ItemNode> readEquipment(Address inventoryControllerField) const;
    void refresh(sched::Clock::time_point now);
    void publish();

    std::shared_ptr<const RaidSession> session_;
    const Game& game_;
    WorldState& world_;
    std::unordered_map<Address, Entry> entries_;
    std::unordered_map<Address, BuildFailure> failures_;
    std::unordered_set<Address> registered_;
    std::uint32_t nextId_ = 1;
    std::uint64_t revision_ = 0;
    std::size_t buildCursor_ = 0;

    // Shared between the live tasks (writer) and the equipment task (reader).
    sched::Published<std::vector<Ref>> refs_;
    std::vector<Ref> lastRefs_;  // live thread only
    // Equipment task only.
    std::unordered_map<std::uint32_t, EquipmentState> equipment_;
    std::uint64_t equipmentRevision_ = 0;
};

}  // namespace radar::eft
