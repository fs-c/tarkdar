#include "game/eft/players/PlayerKinds.hpp"

#include "game/eft/Names.hpp"
#include "game/eft/Read.hpp"

#include <eft_offsets.hpp>

#include <algorithm>

namespace radar::eft {

using mem::Freshness;

namespace {

// Fresh reads throughout: a just-spawned player's fields may still be zero, and a cached zero would
// make every retry fail the same way.
constexpr auto kFresh = Freshness::Fresh;

using Result = std::expected<PlayerLayout, std::string>;

// A short managed string field (voice, nickname, group id); empty if null or unreadable.
std::string readString(const Game& game, Address field) {
    return game.managed.readStringField(field, 64, il2cpp::Managed::Overflow::Truncate, kFresh).value_or("");
}

// Full EFT.Player: Profile → Info → Side (and Settings → Role), _playerBody, MovementContext.
Result buildClient(const Game& game, Address instance, PlayerLayout layout) {
    const Address profile = readPointer(game, instance + off::Player::Profile, kFresh);
    if (!profile) return std::unexpected("Player.Profile is null");
    const Address info = readPointer(game, profile + off::Profile::Info, kFresh);
    if (!info) return std::unexpected("Profile.Info is null");
    if (!readPointer(game, instance + off::Player::_playerBody, kFresh)) return std::unexpected("Player._playerBody is null");
    const Address movement = readPointer(game, instance + off::Player::MovementContext, kFresh);
    if (!movement) return std::unexpected("Player.MovementContext is null");
    std::int32_t side = 0;
    if (!game.mem.tryRead(info + off::PlayerInfo::Side, side, kFresh)) return std::unexpected("PlayerInfo.Side unreadable");

    layout.side = static_cast<Side>(side);
    // Role, nickname and group are identity, not needed to track the player: missing ones don't fail
    // the build.
    if (const Address settings = readPointer(game, info + off::PlayerInfo::Settings, kFresh)) {
        std::int32_t role = 0;
        if (game.mem.tryRead(settings + off::ProfileSettings::Role, role, kFresh)) layout.role = role;
    }
    layout.nickname = readString(game, info + off::PlayerInfo::Nickname);
    layout.groupId = readString(game, info + off::PlayerInfo::GroupId);
    layout.ai = layout.kind != PlayerKind::Local;  // a full Player that isn't ours is a local bot
    layout.rotationField = movement + off::MovementContext::_rotation;
    layout.corpseField = instance + off::Player::Corpse;
    layout.bodyField = instance + off::Player::_playerBody;
    layout.inventoryControllerField = instance + off::Player::_inventoryController;
    return layout;
}

// ObservedPlayerView: ObservedPlayerController → HealthController / MovementController →
// ObservedPlayerStateContext; side, AI flag and voice on the view itself.
Result buildObserved(const Game& game, Address instance, PlayerLayout layout) {
    const Address controller = readPointer(game, instance + off::ObservedPlayerView::ObservedPlayerController, kFresh);
    if (!controller) return std::unexpected("ObservedPlayerView.ObservedPlayerController is null");
    const Address health = readPointer(game, controller + off::ObservedPlayerController::HealthController, kFresh);
    if (!health) return std::unexpected("ObservedPlayerController.HealthController is null");
    const Address movement = readPointer(game, controller + off::ObservedPlayerController::MovementController, kFresh);
    if (!movement) return std::unexpected("ObservedPlayerController.MovementController is null");
    const Address state = readPointer(game, movement + off::ObservedMovementController::ObservedPlayerStateContext, kFresh);
    if (!state) return std::unexpected("ObservedMovementController.ObservedPlayerStateContext is null");
    std::uint8_t isAi = 0;
    std::int32_t side = 0;
    if (!game.mem.tryRead(instance + off::ObservedPlayerView::IsAI, isAi, kFresh) ||
        !game.mem.tryRead(instance + off::ObservedPlayerView::Side, side, kFresh))
        return std::unexpected("ObservedPlayerView.IsAI / Side unreadable");

    layout.ai = isAi != 0;
    layout.side = static_cast<Side>(side);
    layout.voice = readString(game, instance + off::ObservedPlayerView::Voice);
    layout.nickname = readString(game, instance + off::ObservedPlayerView::NickName);
    layout.groupId = readString(game, instance + off::ObservedPlayerView::GroupId);
    layout.role = readObservedRole(game, instance);
    layout.rotationField = state + off::ObservedPlayerStateContext::Rotation;
    layout.corpseField = health + off::ObservedHealthController::PlayerCorpse;
    layout.bodyField = instance + off::ObservedPlayerView::PlayerBody;
    layout.inventoryControllerField = controller + off::ObservedPlayerController::InventoryController;
    return layout;
}

bool isClientClass(const Game& game, Address instance, std::string_view name) {
    return std::ranges::find(kClientPlayerClasses, name) != kClientPlayerClasses.end() ||
           game.managed.isInstanceOf(instance, kPlayerBaseClass);
}

}  // namespace

std::optional<std::int32_t> readObservedRole(const Game& game, Address instance) {
    const Address aiData = readPointer(game, instance + off::ObservedPlayerView::AIData, kFresh);
    if (!aiData) return std::nullopt;
    const std::string cls = game.managed.classNameOf(aiData);
    std::uint32_t hostilityField = 0;
    if (cls == "StubAIData") hostilityField = off::StubAIData::BotHostilityData;
    else if (cls == "AIData") hostilityField = off::AIData::BotHostilityData;
    else return std::nullopt;
    const Address hostility = readPointer(game, aiData + hostilityField, kFresh);
    if (!hostility) return std::nullopt;
    std::int32_t role = 0;
    if (!game.mem.tryRead(hostility + off::BotHostilityData::Role, role, kFresh)) return std::nullopt;
    return role;
}

Result buildPlayerLayout(const Game& game, Address instance, bool isLocal) {
    PlayerLayout layout;
    layout.className = game.managed.classNameOf(instance);
    if (layout.className.empty()) return std::unexpected("class name unreadable");
    if (isLocal) {
        layout.kind = PlayerKind::Local;
        return buildClient(game, instance, std::move(layout));
    }
    if (isClientClass(game, instance, layout.className)) {
        layout.kind = PlayerKind::Client;
        return buildClient(game, instance, std::move(layout));
    }
    layout.kind = PlayerKind::Observed;
    return buildObserved(game, instance, std::move(layout));
}

}  // namespace radar::eft
