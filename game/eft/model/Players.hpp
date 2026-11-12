#pragma once

#include "core/math/Math.hpp"

#include <array>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace radar::eft {

// EPlayerSide flags, as stored in Profile.Info.Side.
enum class Side : std::int32_t { Unknown = 0, Usec = 1, Bear = 2, Savage = 4 };

// Which object layout the player has (see game/eft/players/PlayerKinds.hpp).
enum class PlayerKind : std::uint8_t {
    Local,     // our own player (full EFT.Player)
    Client,    // another full EFT.Player: a bot simulated on this machine
    Observed,  // ObservedPlayerView: a network replica of a player or bot simulated elsewhere
};

// "local", "client", "observed" (also the protocol's names).
[[nodiscard]] constexpr const char* kindName(PlayerKind k) noexcept {
    switch (k) {
    case PlayerKind::Local: return "local";
    case PlayerKind::Client: return "client";
    case PlayerKind::Observed: return "observed";
    }
    return "client";
}

// Body joints, in the order of PlayerState::joints (also the protocol's order). The first
// kPositionJoints are the bones the position is derived from.
enum class Joint : std::uint8_t {
    Base,  // the skeleton root, at floor level
    LeftFoot,
    RightFoot,
    Pelvis,
    Chest,  // top of the spine
    Neck,
    Head,
    LeftHip,
    LeftKnee,
    RightHip,
    RightKnee,
    LeftShoulder,
    LeftElbow,
    LeftHand,
    RightShoulder,
    RightElbow,
    RightHand,
};
inline constexpr std::size_t kJointCount = 17;
inline constexpr std::size_t kPositionJoints = 3;
using Joints = std::array<math::Vec3, kJointCount>;

struct PlayerState {
    std::uint32_t id = 0;  // small, stable within a raid, never reused in a raid
    bool local = false;
    PlayerKind kind = PlayerKind::Client;
    // Client players are always AI; observed players carry their own flag.
    bool ai = false;
    Side side = Side::Unknown;
    bool dead = false;
    // No longer in the registered-player list (extracted, despawned) but not dead.
    bool absent = false;
    // Observed players: the voice preset (bot roles and bosses have their own); empty otherwise.
    std::string voice{};
    // The raw WildSpawnType value (names and values are mapped by the frontend); nullopt if unread.
    // Full EFT.Player (local and client bots): Profile.Info.Settings.Role. Observed players:
    // AIData → BotHostilityData._role (unverified source; may be read some time after the player
    // appears). Only meaningful for AI: humans carry a default (our own PMC reads 1, assault).
    std::optional<std::int32_t> role{};
    // Nickname and group id (players spawned together share one, e.g. a boss and its guards).
    std::string nickname{};
    std::string groupId{};

    // World position (Unity metres: x east, y up, z north); nullopt until first resolved.
    std::optional<math::Vec3> position;
    // Look direction in degrees, as stored by the game (MovementContext rotation): yaw around the
    // vertical axis, pitch up/down.
    float yaw = 0;
    float pitch = 0;
    // Joint positions relative to `position` (Joint order), from the same skeleton read; nullopt
    // when the skeleton is only partly readable or doesn't look like a body.
    std::optional<Joints> joints{};
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
