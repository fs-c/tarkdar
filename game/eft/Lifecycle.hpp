#pragma once

#include "core/mem/Target.hpp"
#include "core/sched/Published.hpp"
#include "game/eft/Status.hpp"
#include "game/eft/raid/RaidSession.hpp"

#include <atomic>
#include <functional>
#include <memory>
#include <stop_token>
#include <vector>

namespace radar::eft {

// The backend's top-level state machine, run on one thread:
//
//   WaitingForProcess/Modules ──attached──► WaitingForRaid ──raid found──► InRaid ──ended──► Cooldown ─┐
//            ▲                                    ▲                                                     │
//            └──────── process lost ──────────────┴─────────────────────────────────────────────────────┘
//
// In a raid it starts two worker threads (live, background) running the tasks of the per-raid
// subsystems, and checks every RaidMonitor::kInterval whether the raid has ended. Losing the
// process (or a re-attach) ends the raid immediately.
class Lifecycle {
public:
    using SubsystemFactory =
        std::function<std::vector<std::unique_ptr<RaidSubsystem>>(std::shared_ptr<const RaidSession>)>;

    static constexpr auto kAttachPollInterval = std::chrono::seconds(1);
    static constexpr auto kRaidPollInterval = std::chrono::milliseconds(2500);
    static constexpr auto kCooldown = std::chrono::seconds(3);

    Lifecycle(mem::Target& target, SubsystemFactory factory) : target_(target), factory_(std::move(factory)) {}

    void run(std::stop_token stop);

    [[nodiscard]] std::shared_ptr<const Status> status() const { return status_.get(); }
    // Current raid, or null between raids.
    [[nodiscard]] std::shared_ptr<const RaidSession> session() const { return session_.load(); }

private:
    void publish(Status::State state, bool pending = false);
    void runRaid(std::stop_token stop, const Game& game, const RaidCandidate& raid);
    bool stillAttached(std::uint64_t generation);

    mem::Target& target_;
    SubsystemFactory factory_;
    sched::Published<Status> status_;
    sched::AtomicSharedPtr<const RaidSession> session_;
    std::uint64_t raidCounter_ = 0;
    bool offsetsMismatch_ = false;
};

}  // namespace radar::eft
