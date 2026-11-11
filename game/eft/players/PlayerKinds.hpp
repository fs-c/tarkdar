#pragma once

#include "game/eft/Game.hpp"
#include "game/eft/model/Players.hpp"

#include <expected>
#include <string>

// The game keeps two unrelated object layouts in the registered-player list:
//  - full EFT.Player objects (classes ClientPlayer / LocalPlayer): the local player, and bots in a
//    raid simulated on this machine;
//  - EFT.NextObservedPlayer.ObservedPlayerView: a lighter, network-driven replica used for players
//    (and bots) simulated elsewhere, e.g. by a server in online or co-op raids.
// Everything after the build reads through the addresses resolved here, so the rest of the player
// code doesn't care which layout a player has.
namespace radar::eft {

// Addresses and identity resolved once when a player is first seen.
struct PlayerLayout {
    PlayerKind kind = PlayerKind::Client;
    std::string className;
    bool ai = false;
    Side side = Side::Unknown;
    std::string voice;  // observed players only: the voice preset, which names bot roles/bosses
    // WildSpawnType. Full Players: Profile.Info.Settings.Role. Observed players: see readObservedRole.
    std::optional<std::int32_t> role;
    std::string nickname;
    std::string groupId;
    // Fields read later:
    Address rotationField = 0;             // Vector2 (yaw, pitch) in degrees
    Address corpseField = 0;               // pointer; non-null once the player is dead
    Address bodyField = 0;                 // pointer to the PlayerBody (skeleton)
    Address inventoryControllerField = 0;  // pointer to the InventoryController (equipment)
};

// Classifies the entry and resolves its layout. On failure, the error names the step that failed
// (for logs and --diagnose).
//  - isLocal (the world's main player) → Local, read with the full Player layout;
//  - class in kClientPlayerClasses, or derived from kPlayerBaseClass → Client;
//  - anything else → Observed.
[[nodiscard]] std::expected<PlayerLayout, std::string> buildPlayerLayout(const Game& game, Address instance,
                                                                       bool isLocal);

// The role of an observed player: ObservedPlayerView.AIData (StubAIData on observers, AIData if
// simulated here) → BotHostilityData._role. nullopt while any link is missing (the AI data may be set
// up after the player is registered) or if the AI data has an unexpected class.
[[nodiscard]] std::optional<std::int32_t> readObservedRole(const Game& game, Address instance);

}  // namespace radar::eft
