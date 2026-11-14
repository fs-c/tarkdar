// radar-backend entry point.
//
// Live mode: connects to the memory source, runs the game lifecycle (attach, find raids, track
// players) and streams the state to the web frontend.
// Offline mode: serves the frontend and past raid recordings, without any memory source.

#include "app/Diagnose.hpp"
#include "app/Options.hpp"
#include "core/log/Log.hpp"
#include "core/mem/Target.hpp"
#include "core/mem/VmmBackend.hpp"
#include "game/eft/BuildCheck.hpp"
#include "game/eft/Lifecycle.hpp"
#include "game/eft/Names.hpp"
#include "game/eft/model/WorldState.hpp"
#include "game/eft/players/Players.hpp"
#include "game/eft/world/Exfils.hpp"
#include "game/eft/world/Explosives.hpp"
#include "game/eft/world/Vehicles.hpp"
#include "game/eft/world/Loot.hpp"
#include "server/Feeds.hpp"
#include "server/MessageHub.hpp"
#include "server/Server.hpp"

#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdio>
#include <memory>
#include <optional>
#include <string>
#include <thread>
#include <vector>

namespace {

std::atomic<bool> gStop{false};
void onSignal(int) { gStop.store(true); }

// Connectivity check: wait for the attach, print module info and the build check.
int runOnce(radar::mem::Target& target, std::optional<int> timeoutSeconds) {
    using namespace radar;
    const auto start = std::chrono::steady_clock::now();
    while (!gStop.load()) {
        if (target.poll() == mem::Target::State::Attached) {
            log::info("attached to {} (pid {})", target.processName(), target.pid().value_or(0));
            for (const auto& [name, info] : target.modules())
                log::info("  {:<20} base {:#014x} size {:#x}", name, info.base, info.size);
            eft::logBuildCheck(eft::checkBuild(target));
            return 0;
        }
        if (timeoutSeconds && std::chrono::steady_clock::now() - start > std::chrono::seconds(*timeoutSeconds)) {
            log::error("not attached within {} s (state: {})", *timeoutSeconds, mem::stateName(target.state()));
            return 1;
        }
        std::this_thread::sleep_for(std::chrono::seconds(1));
    }
    return 0;
}

// Logs a player summary (the local player at info level, others at debug level).
void logPlayerSummary(const radar::eft::PlayersSnapshot& snap) {
    using namespace radar;
    if (snap.raidId == 0) return;
    int alive = 0, dead = 0, absent = 0, positioned = 0;
    for (const auto& p : snap.players) {
        (p.dead ? dead : p.absent ? absent : alive)++;
        if (p.position) ++positioned;
    }
    log::info("players: {} alive, {} dead, {} absent ({} with position)", alive, dead, absent, positioned);
    for (const auto& p : snap.players) {
        if (!p.position) continue;
        const auto line = std::format("  #{} {}{} side {}{}{} {}{}: ({:.1f}, {:.1f}, {:.1f}) yaw {:.0f} pitch {:.0f}",
                                      p.id, radar::eft::kindName(p.kind), p.ai ? " ai" : "", static_cast<int>(p.side),
                                      p.voice.empty() ? "" : " voice " + p.voice,
                                      p.role ? std::format(" role {}", *p.role) : "", p.dead ? "dead" : "alive",
                                      p.absent ? " absent" : "", p.position->x, p.position->y, p.position->z, p.yaw,
                                      p.pitch);
        if (p.local) log::info("{}", line);
        else log::debug("{}", line);
    }
}

}  // namespace

int main(int argc, char** argv) {
    using namespace radar;

    std::string error;
    auto options = app::parseOptions(argc, argv, error);
    if (!options) {
        if (!error.empty()) std::fprintf(stderr, "error: %s\n\n", error.c_str());
        app::printUsage(argv[0]);
        return error.empty() ? 0 : 2;
    }
    if (options->verbose) log::setMinLevel(log::Level::Debug);

    std::signal(SIGINT, onSignal);
    std::signal(SIGTERM, onSignal);

    server::MessageHub hub;
    std::unique_ptr<server::RaidRecorder> recorder;
    if (!options->offline && !options->noRecord && !options->once && !options->diagnose) {
        recorder = std::make_unique<server::RaidRecorder>(
            server::RaidRecorder::Config{.dir = options->server.recordingsRoot, .keep = options->keepRecordings});
        log::info("recording raids to {}", options->server.recordingsRoot.string());
    }

    std::unique_ptr<server::Server> httpServer;
    if (!options->noServer && !options->once && !options->diagnose) {
        httpServer = std::make_unique<server::Server>(options->server, hub, recorder.get());
        if (!httpServer->start()) return 1;
    }

    // ---- offline mode -----------------------------------------------------------------------------
    if (options->offline) {
        log::info("offline: serving recordings from {}", options->server.recordingsRoot.string());
        while (!gStop.load()) std::this_thread::sleep_for(std::chrono::milliseconds(100));
        httpServer->stop();
        return 0;
    }

    // ---- live mode --------------------------------------------------------------------------------
    mem::VmmBackend backend(options->vmm);
    log::info("opening memory source: {}", options->vmm.device);
    if (auto opened = backend.open(); !opened) {
        log::error("{}", opened.error());
        return 1;
    }

    std::vector<std::string> modules(eft::kRequiredModules.begin(), eft::kRequiredModules.end());
    mem::Target target(backend, std::string(eft::kProcessName), modules);

    if (options->once) return runOnce(target, options->timeoutSeconds);
    if (options->diagnose) return app::runDiagnose(target, options->timeoutSeconds.value_or(30), stdout);

    eft::WorldState world;
    eft::Lifecycle lifecycle(target, [&world](std::shared_ptr<const eft::RaidSession> session) {
        std::vector<std::unique_ptr<eft::RaidSubsystem>> subsystems;
        auto players = std::make_unique<eft::Players>(session, world);
        auto vehicles = std::make_unique<eft::Vehicles>(session, world, *players);
        subsystems.push_back(std::move(players));
        subsystems.push_back(std::make_unique<eft::Exfils>(session, world));
        subsystems.push_back(std::make_unique<eft::Explosives>(session, world));
        subsystems.push_back(std::move(vehicles));
        subsystems.push_back(std::make_unique<eft::Loot>(session, world));
        return subsystems;
    });
    server::LiveFeed feed(
        {.status = [&lifecycle] { return lifecycle.status(); }, .world = &world, .recorder = recorder.get()}, hub);

    std::jthread lifecycleThread([&](std::stop_token stop) { lifecycle.run(stop); });
    std::jthread feedThread([&](std::stop_token stop) { feed.run(stop); });

    auto lastSummary = std::chrono::steady_clock::now();
    while (!gStop.load()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
        if (std::chrono::steady_clock::now() - lastSummary >= std::chrono::seconds(5)) {
            lastSummary = std::chrono::steady_clock::now();
            logPlayerSummary(*world.players.get());
            if (world.players.get()->raidId != 0) {
                const auto exfils = world.exfils.get();
                const auto explosives = world.explosives.get();
                const auto loot = world.loot.get();
                log::info("world: {} exfils, {} grenades, {} tripwires, {} loot entries", exfils->exfils.size(),
                          explosives->grenades.size(), explosives->tripwires.size(), loot->loot.size());
            }
        }
    }

    feedThread.request_stop();
    lifecycleThread.request_stop();
    feedThread.join();
    lifecycleThread.join();
    if (recorder) recorder->finish();  // a raid in progress: keep what's there
    if (httpServer) httpServer->stop();
    backend.close();
    return 0;
}
