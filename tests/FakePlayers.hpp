#pragma once

// Builders on top of FakeWorld for the players it does not create itself: network-replicated
// ObservedPlayerViews, their identity / AI data, and per-player state changes (kill, detached bones).
// Assumes the player comes from FakeWorld (newPlayer / newObservedPlayer), so it is in fakePlayers.

#include "FakeWorld.hpp"

namespace radar::test {

// A network-replicated ObservedPlayerView: controller → health / movement → state context, side,
// AI flag and voice on the view, and the same kind of skeleton as newPlayer.
inline Address newObservedPlayer(FakeWorld& w, int side = 4, bool ai = true, std::u16string_view voice = u"BossKilla",
                          std::optional<math::Vec3> position = std::nullopt) {
    FakeWorld::FakePlayer fp;
    fp.instance = w.heap.object(w.observedClass, 0x200);
    const Address controller = w.heap.alloc(0x200), health = w.heap.alloc(0x100), movement = w.heap.alloc(0x100),
                  state = w.heap.alloc(0x200);
    w.heap.put<Address>(fp.instance + off::ObservedPlayerView::ObservedPlayerController, controller);
    w.heap.put<Address>(controller + off::ObservedPlayerController::HealthController, health);
    w.heap.put<Address>(controller + off::ObservedPlayerController::MovementController, movement);
    w.heap.put<Address>(movement + off::ObservedMovementController::ObservedPlayerStateContext, state);
    w.heap.put<std::uint8_t>(fp.instance + off::ObservedPlayerView::IsAI, ai ? 1 : 0);
    w.heap.put<std::int32_t>(fp.instance + off::ObservedPlayerView::Side, side);
    w.heap.put<Address>(fp.instance + off::ObservedPlayerView::Voice, w.heap.managedString(voice));
    fp.rotation = state + off::ObservedPlayerStateContext::Rotation;
    fp.corpseField = health + off::ObservedHealthController::PlayerCorpse;
    return w.addSkeleton(fp, fp.instance + off::ObservedPlayerView::PlayerBody, position);
}

// Nickname and group id of an observed player.
inline void setObservedIdentity(FakeWorld& w, Address instance, std::u16string_view nickname, std::u16string_view groupId) {
    w.heap.put<Address>(instance + off::ObservedPlayerView::NickName, w.heap.managedString(nickname));
    w.heap.put<Address>(instance + off::ObservedPlayerView::GroupId, w.heap.managedString(groupId));
}

// An observed player's AI data (class `aiClass`: StubAIData or AIData) → BotHostilityData._role.
inline void setObservedRole(FakeWorld& w, Address instance, int role, std::string_view aiClass = "StubAIData") {
    const bool stub = aiClass == "StubAIData";
    const Address aiData = w.heap.object(w.heap.klass(aiClass), 0x200);
    const Address hostility = w.heap.alloc(0x80);
    w.heap.put<Address>(aiData + (stub ? off::StubAIData::BotHostilityData : off::AIData::BotHostilityData), hostility);
    w.heap.put<std::int32_t>(hostility + off::BotHostilityData::Role, role);
    w.heap.put<Address>(instance + off::ObservedPlayerView::AIData, aiData);
}

// Detaches (or re-attaches) a joint bone's managed Transform from its native transform, as for
// a bone not set up yet.
inline void setBoneAttached(FakeWorld& w, Address player, eft::Joint joint, bool attached) {
    const auto& fp = w.fakePlayers.at(player);
    const auto j = static_cast<std::size_t>(joint);
    w.heap.put<Address>(fp.managed[j] + kIl2Cpp.unityObjectCachedPtr, attached ? fp.native[j] : 0);
}
inline void kill(FakeWorld& w, Address player) { w.heap.put<Address>(w.fakePlayers.at(player).corpseField, w.heap.alloc(0x40)); }

}  // namespace radar::test
