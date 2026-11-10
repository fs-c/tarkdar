#pragma once

#include <array>
#include <string_view>

// Game-specific names, kept in one place so that targeting a different build is a change here.
// Values assume the SPT client matches live EFT; verify on the real setup.
namespace radar::eft {

inline constexpr std::string_view kProcessName = "EscapeFromTarkov.exe";
inline constexpr std::string_view kGameAssembly = "GameAssembly.dll";  // IL2CPP managed code
inline constexpr std::string_view kUnityPlayer = "UnityPlayer.dll";    // Unity engine

// Modules that must be loaded before we consider the game attached.
inline constexpr std::array kRequiredModules = {kGameAssembly, kUnityPlayer};

// Loot classification by runtime class (matched against the class and its base classes, by short
// name, so live-EFT replicas like ObservedLootItem and offline classes both match). Order matters:
// a Corpse is also a LootItem.
inline constexpr std::string_view kLootClassCorpse = "Corpse";
inline constexpr std::string_view kLootClassContainer = "LootableContainer";
inline constexpr std::string_view kLootClassItem = "LootItem";

// Items that can hold other items (slots and/or grids): weapons, mods, armour, rigs, containers.
inline constexpr std::string_view kCompoundItemClass = "CompoundItem";

// Player classes in the registered-player list (see game/eft/players/PlayerKinds.hpp). Entries whose
// class is one of these (or derives from EFT.Player) have the full Player layout; anything else is
// read as a networked ObservedPlayerView.
inline constexpr std::array kClientPlayerClasses = {std::string_view("ClientPlayer"), std::string_view("LocalPlayer")};
inline constexpr std::string_view kPlayerBaseClass = "EFT.Player";

}  // namespace radar::eft
