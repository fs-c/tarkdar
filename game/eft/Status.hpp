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

[[nodiscard]] const char* stateName(Status::State state) noexcept;

}  // namespace radar::eft
