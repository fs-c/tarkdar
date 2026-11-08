#pragma once

#include "core/math/Math.hpp"

#include <cstdint>
#include <optional>
#include <vector>

namespace radar::eft {

// EPlayerSide flags, as stored in Profile.Info.Side.
enum class Side : std::int32_t { Unknown = 0, Usec = 1, Bear = 2, Savage = 4 };

struct PlayerState {
    std::uint32_t id = 0;  // small, stable within a raid, never reused in a raid
    bool local = false;
    // Every non-local full EFT.Player is treated as AI (offline raids have no other humans).
    bool ai = false;
    Side side = Side::Unknown;
    bool dead = false;
    // No longer in the registered-player list (extracted, despawned) but not dead.
    bool absent = false;

    // World position (Unity metres: x east, y up, z north); nullopt until first resolved.
    std::optional<math::Vec3> position;
    // Look direction in degrees, as stored by the game (MovementContext rotation): yaw around the
    // vertical axis, pitch up/down.
    float yaw = 0;
    float pitch = 0;
};

struct PlayersSnapshot {
    std::uint64_t raidId = 0;  // 0: no raid
    std::uint64_t revision = 0;
    std::vector<PlayerState> players;  // ordered by id
    [[nodiscard]] const PlayerState* local() const {
        for (const auto& p : players)
            if (p.local) return &p;
        return nullptr;
    }
};

}  // namespace radar::eft
