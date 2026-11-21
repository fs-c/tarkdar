#pragma once

#include <cstdint>
#include <string>

namespace radar::eft {

// What the backend is doing, published for the UI.
struct Status {
    enum class State {
        WaitingForProcess,  // game not running
        WaitingForModules,  // game starting up
        WaitingForRaid,     // in menus / loading
        InRaid,
        Cooldown,           // short pause after a raid before searching again
    };
    State state = State::WaitingForProcess;
    bool raidPending = false;        // WaitingForRaid: a raid world exists but isn't ready yet
    std::string locationId{};        // InRaid
    std::uint64_t raidId = 0;        // InRaid
    std::uint64_t attachGeneration = 0;
    bool offsetsMismatch = false;    // loaded game build differs from the offsets' build
};

[[nodiscard]] inline const char* stateName(Status::State state) noexcept {
    switch (state) {
    case Status::State::WaitingForProcess: return "waiting for process";
    case Status::State::WaitingForModules: return "waiting for modules";
    case Status::State::WaitingForRaid: return "waiting for raid";
    case Status::State::InRaid: return "in raid";
    case Status::State::Cooldown: return "cooldown";
    }
    return "?";
}

}  // namespace radar::eft
