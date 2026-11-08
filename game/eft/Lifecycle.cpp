#include "game/eft/Lifecycle.hpp"

#include "core/log/Log.hpp"
#include "game/eft/BuildCheck.hpp"
#include "game/eft/raid/RaidMonitor.hpp"

#include <thread>

namespace radar::eft {

const char* stateName(Status::State state) noexcept {
    switch (state) {
    case Status::State::WaitingForProcess: return "waiting for process";
    case Status::State::WaitingForModules: return "waiting for modules";
    case Status::State::WaitingForRaid: return "waiting for raid";
    case Status::State::InRaid: return "in raid";
    case Status::State::Cooldown: return "cooldown";
    }
    return "?";
}

void Lifecycle::publish(Status::State state, bool pending) {
    const auto previous = status_.get();
    Status s;
    s.state = state;
    s.raidPending = pending;
    s.attachGeneration = target_.generation();
    s.offsetsMismatch = offsetsMismatch_;
    if (const auto session = session_.load(); session && state == Status::State::InRaid) {
        s.locationId = session->start.locationId;
        s.raidId = session->id;
    }
    if (previous->state != s.state || previous->raidPending != s.raidPending)
        log::info("status: {}{}", stateName(s.state), s.raidPending ? " (raid found, waiting for it to start)" : "");
    status_.publish(std::move(s));
}

bool Lifecycle::stillAttached(std::uint64_t generation) {
    return target_.poll() == mem::Target::State::Attached && target_.generation() == generation;
}

void Lifecycle::run(std::stop_token stop) {
    std::optional<Game> game;
    std::optional<RaidFinder> finder;

    while (!stop.stop_requested()) {
        const auto state = target_.poll();
        if (state != mem::Target::State::Attached) {
            game.reset();
            finder.reset();
            publish(state == mem::Target::State::WaitingForModules ? Status::State::WaitingForModules
                                                                     : Status::State::WaitingForProcess);
            if (!sched::sleepFor(stop, kAttachPollInterval)) break;
            continue;
        }

        if (!game || game->generation != target_.generation()) {
            log::info("attached to {} (pid {}, attach #{})", target_.processName(), target_.pid().value_or(0),
                      target_.generation());
            for (const auto& [name, info] : target_.modules())
                log::info("  {:<20} base {:#014x} size {:#x}", name, info.base, info.size);
            offsetsMismatch_ = logBuildCheck(checkBuild(target_));
            game = Game::fromTarget(target_);
            finder.emplace(*game);  // new process: no ended-world guard carried over
            finder->restart(sched::Clock::now());
        }

        const auto result = finder->poll(sched::Clock::now());
        if (!result.raid) {
            publish(Status::State::WaitingForRaid, result.pending);
            if (!sched::sleepFor(stop, kRaidPollInterval)) break;
            continue;
        }

        runRaid(stop, *game, *result.raid);
        finder->markEnded(result.raid->localGameWorld);
        if (stop.stop_requested()) break;
        if (target_.state() != mem::Target::State::Attached) continue;  // process gone: nothing to wait for
        publish(Status::State::Cooldown);
        if (!sched::sleepFor(stop, kCooldown)) break;
        finder->restart(sched::Clock::now());
    }
    session_.store(nullptr);
}

void Lifecycle::runRaid(std::stop_token stop, const Game& game, const RaidCandidate& raid) {
    auto session = std::make_shared<RaidSession>(RaidSession{
        .id = ++raidCounter_,
        .game = game,
        .start = raid,
        .startedAt = sched::Clock::now(),
    });
    log::info("raid #{} started: location {}, GameWorld {:#x}, local player {:#x}, {} registered players",
              session->id, raid.locationId, raid.localGameWorld, raid.localPlayer, raid.registeredCount);
    session_.store(session);
    publish(Status::State::InRaid);

    std::string endReason;
    {
        auto subsystems = factory_ ? factory_(session) : std::vector<std::unique_ptr<RaidSubsystem>>{};
        sched::TaskRunner live("live"), background("background");
        for (auto& s : subsystems) s->registerTasks(live, background);

        // Declared after the runners and subsystems: destroyed (stopped and joined) first.
        std::jthread liveThread([&](std::stop_token st) { live.run(st); });
        std::jthread backgroundThread([&](std::stop_token st) { background.run(st); });

        RaidMonitor monitor(raid.localGameWorld, session->startedAt);
        while (true) {
            if (!sched::sleepFor(stop, RaidMonitor::kInterval)) {
                endReason = "shutting down";
                break;
            }
            if (!stillAttached(game.generation)) {
                endReason = "game process lost";
                break;
            }
            if (auto reason = monitor.check(game, sched::Clock::now())) {
                endReason = *reason;
                break;
            }
        }
        liveThread.request_stop();
        backgroundThread.request_stop();
    }  // workers joined, then subsystems destroyed

    session_.store(nullptr);
    log::info("raid #{} ended: {}", session->id, endReason);
}

}  // namespace radar::eft
