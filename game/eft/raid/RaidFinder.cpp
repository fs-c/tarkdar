#include "game/eft/raid/RaidFinder.hpp"

#include "core/log/Log.hpp"
#include "game/eft/Maps.hpp"
#include "game/eft/raid/Roster.hpp"

#include "game/eft/Read.hpp"

#include <eft_offsets.hpp>

namespace radar::eft {

using mem::Freshness;
using mem::MemoryView;

namespace {
constexpr std::size_t kMaxLocationChars = 64;

}  // namespace

WorldCheck checkWorld(const Game& game, Address localGameWorld, Address localPlayer, Address gameWorldObject) {
    WorldCheck result;
    auto reject = [&](std::string reason) {
        result.status = WorldCheck::Status::Rejected;
        result.reason = std::move(reason);
        return result;
    };
    if (!MemoryView::isUserPointer(localGameWorld)) return reject("invalid GameWorld pointer");
    if (!MemoryView::isUserPointer(localPlayer))
        localPlayer = readPointer(game, localGameWorld + off::ClientLocalGameWorld::MainPlayer, Freshness::Fresh);

    // Location id: from the GameWorld, falling back to the local player's.
    auto location = game.managed.readStringField(localGameWorld + off::GameWorld::Location, kMaxLocationChars,
                                                 il2cpp::Managed::Overflow::Reject, Freshness::Fresh);
    if ((!location || location->empty()) && localPlayer)
        location = game.managed.readStringField(localPlayer + off::Player::Location, kMaxLocationChars,
                                                il2cpp::Managed::Overflow::Reject, Freshness::Fresh);
    const std::string locationId = location.value_or("");
    if (isLobbyLocation(locationId)) return reject("lobby location '" + locationId + "'");
    if (!isRaidLocation(locationId)) return reject("unknown location '" + locationId + "'");

    RaidCandidate& c = result.candidate;
    c.localGameWorld = localGameWorld;
    c.gameWorldObject = gameWorldObject ? gameWorldObject : localGameWorld;
    c.localPlayer = localPlayer;
    c.locationId = locationId;

    // Roster: a missing list or backing array just means "not ready yet"; only an implausible count
    // rejects the world.
    if (const Address list = readPointer(game, localGameWorld + off::ClientLocalGameWorld::RegisteredPlayers, Freshness::Fresh)) {
        std::int32_t count = 0;
        game.mem.tryRead(list + game.managed.layout().listSize, count, Freshness::Fresh);
        if (count < 0 || count > kMaxRegisteredPlayers) return reject("implausible RegisteredPlayers count");
        if (readPointer(game, list + game.managed.layout().listItems, Freshness::Fresh)) c.registeredCount = count;
    }

    if (c.registeredCount <= 0 || !localPlayer) {
        result.status = WorldCheck::Status::Pending;
        result.reason = !localPlayer ? "no local player yet" : "no registered players yet";
        return result;
    }
    result.status = WorldCheck::Status::Ready;
    return result;
}

std::optional<LocalPlayerWorld> localPlayerWorld(const Game& game) {
    const auto table = game.typeInfoTable();
    const auto statics = table ? table->staticFields(off::GamePlayerOwner::TypeIndex) : std::nullopt;
    if (!statics) return std::nullopt;
    LocalPlayerWorld r;
    r.player = readPointer(game, *statics + off::GamePlayerOwner::MyPlayer, Freshness::Fresh);
    if (!r.player) return std::nullopt;
    r.world = readPointer(game, r.player + off::Player::GameWorld, Freshness::Fresh);
    if (!r.world) return std::nullopt;
    return r;
}

void RaidFinder::restart(sched::Clock::time_point now) {
    searchStart_ = now;
    lastSceneScan_.reset();
    pending_.reset();
    pendingAttempts_ = 0;
}

WorldCheck RaidFinder::check(Address localGameWorld, Address localPlayer, Address gameWorldObject) {
    WorldCheck wc = checkWorld(game_, localGameWorld, localPlayer, gameWorldObject);
    if (endedWorld_ && localGameWorld == endedWorld_) {
        // The world of the raid that just ended. While it still looks like a running raid it is
        // lingering, so refuse it. Once it stops looking ready it has been torn down, so a ready world
        // at the same address later is a new raid that reuses the allocation.
        if (wc.status == WorldCheck::Status::Ready) {
            if (!endedReadySince_) endedReadySince_ = now_;
            if (now_ - *endedReadySince_ < kEndedWorldGrace) {
                wc.status = WorldCheck::Status::Rejected;
                wc.reason = "world of the raid that just ended";
                return wc;
            }
            log::warn("raid finder: the ended raid's world has looked like a running raid for {} s; "
                      "accepting it again (the raid end was probably false)",
                      std::chrono::duration_cast<std::chrono::seconds>(kEndedWorldGrace).count());
        }
        endedWorld_ = 0;
        endedReadySince_.reset();
    } else if (endedWorld_ && wc.status != WorldCheck::Status::Rejected) {
        endedWorld_ = 0;  // a different raid world exists
    }
    return wc;
}

std::optional<WorldCheck> RaidFinder::viaGamePlayerOwner() {
    const auto local = localPlayerWorld(game_);
    if (!local) return std::nullopt;
    return check(local->world, local->player, 0);
}

std::optional<WorldCheck> RaidFinder::viaSceneScan() {
    const auto gom = game_.gameObjectManager();
    if (!gom) return std::nullopt;
    std::optional<WorldCheck> pending;
    for (const auto& object : game_.scene.findByName(*gom, "GameWorld")) {
        const auto world = game_.scene.findManagedComponent(object.native, "EFT.GameWorld", game_.managed);
        if (!world) continue;
        WorldCheck wc = check(*world, 0, object.native);
        if (wc.status == WorldCheck::Status::Ready) return wc;
        if (wc.status == WorldCheck::Status::Pending) pending = std::move(wc);
    }
    return pending;
}

RaidFinder::Result RaidFinder::poll(sched::Clock::time_point now) {
    now_ = now;
    Result result;
    std::optional<RaidCandidate> newPending;

    auto consider = [&](const std::optional<WorldCheck>& wc) {
        if (!wc) return false;
        if (wc->status == WorldCheck::Status::Ready) {
            result.raid = wc->candidate;
            return true;
        }
        if (wc->status == WorldCheck::Status::Pending) newPending = wc->candidate;
        else log::debug("raid finder: rejected world {:#x}: {}", wc->candidate.localGameWorld, wc->reason);
        return false;
    };

    // Retry a pending world first.
    if (pending_) {
        const WorldCheck wc = check(pending_->localGameWorld, 0, pending_->gameWorldObject);
        if (wc.status == WorldCheck::Status::Ready) {
            result.raid = wc.candidate;
        } else if (wc.status == WorldCheck::Status::Pending && ++pendingAttempts_ < kMaxPendingAttempts) {
            // keep waiting
        } else {
            log::debug("raid finder: dropping pending world {:#x}", pending_->localGameWorld);
            pending_.reset();
            pendingAttempts_ = 0;
        }
    }

    if (!result.raid && !consider(viaGamePlayerOwner())) {
        const bool scanAllowed = now - searchStart_ >= kSceneScanDelay &&
                                 (!lastSceneScan_ || now - *lastSceneScan_ >= kSceneScanInterval);
        if (scanAllowed) {
            lastSceneScan_ = now;
            consider(viaSceneScan());
        }
    }

    if (result.raid) {
        pending_.reset();
        pendingAttempts_ = 0;
        return result;
    }
    if (newPending && (!pending_ || pending_->localGameWorld != newPending->localGameWorld)) {
        pending_ = newPending;
        pendingAttempts_ = 0;
    }
    result.pending = pending_.has_value();
    return result;
}

}  // namespace radar::eft
