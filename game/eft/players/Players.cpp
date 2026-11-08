#include "game/eft/players/Players.hpp"

#include "core/log/Log.hpp"
#include "core/mem/ReadBatch.hpp"
#include "game/eft/items/ItemTree.hpp"
#include "game/eft/raid/Roster.hpp"

#include "game/eft/Read.hpp"

#include <eft_offsets.hpp>

#include <algorithm>
#include <cmath>

namespace radar::eft {

using mem::Freshness;
using mem::MemoryView;
using sched::Clock;

namespace {


struct Vec2 {
    float x, y;
};

}  // namespace

Players::Players(std::shared_ptr<const RaidSession> session, WorldState& world)
    : session_(std::move(session)), game_(session_->game), world_(world) {
    publish();
}

Players::~Players() {
    // The raid is over: clear what the UI sees.
    world_.players.publish(PlayersSnapshot{});
    world_.equipment.publish(EquipmentSnapshot{});
}

void Players::registerTasks(sched::TaskRunner& live, sched::TaskRunner& background) {
    background.add("players.equipment", {.interval = kEquipmentInterval, .phase = std::chrono::milliseconds(300)},
                   [this] { equipmentTick(Clock::now()); });
    live.add("players.roster", {.interval = kRosterInterval, .runOnStart = true}, [this] { rosterTick(Clock::now()); });
    live.add("players.positions", {.interval = kPositionInterval, .phase = std::chrono::milliseconds(5)},
             [this] { positionsTick(Clock::now()); });
}

std::optional<Players::Entry> Players::build(Address instance, Address localPlayer) const {
    if (!game_.managed.isInstanceOf(instance, "EFT.Player")) return std::nullopt;

    // Fresh reads: a just-spawned player's fields may still be zero, and a cached zero would make
    // every retry fail the same way.
    constexpr auto fresh = Freshness::Fresh;
    const Address profile = readPointer(game_, instance + off::Player::Profile, fresh);
    const Address info = profile ? readPointer(game_, profile + off::Profile::Info, fresh) : 0;
    const Address body = readPointer(game_, instance + off::Player::_playerBody, fresh);
    const Address movement = readPointer(game_, instance + off::Player::MovementContext, fresh);
    std::int32_t side = 0;
    if (!profile || !info || !body || !movement || !game_.mem.tryRead(info + off::PlayerInfo::Side, side, fresh))
        return std::nullopt;

    Entry e;
    e.instance = instance;
    e.local = instance == localPlayer;
    e.ai = !e.local;
    e.side = static_cast<Side>(side);
    e.rotationField = movement + off::MovementContext::_rotation;
    e.corpseField = instance + off::Player::Corpse;
    return e;
}

void Players::rosterTick(Clock::time_point now) {
    const auto roster = readRoster(game_, session_->start.localGameWorld);
    if (!roster) return;  // keep the previous state; the raid monitor decides whether the raid is over

    registered_.clear();
    registered_.insert(roster->players.begin(), roster->players.end());

    // Build new players: at most kMaxBuildsPerTick attempts, starting at a rotating cursor so a few
    // unbuildable entries can't starve the rest.
    const auto& list = roster->players;
    int attempts = 0;
    std::size_t inspected = 0;
    for (; inspected < list.size() && attempts < kMaxBuildsPerTick; ++inspected) {
        const Address instance = list[(buildCursor_ + inspected) % list.size()];
        if (entries_.contains(instance)) continue;
        auto& failure = failures_[instance];
        if (failure.attempts > 0 && now - failure.last < (failure.attempts >= kMaxFreeBuildAttempts ? kBuildRetry : kMinBuildSpacing))
            continue;
        ++attempts;
        if (auto entry = build(instance, roster->localPlayer)) {
            entry->id = nextId_++;
            failures_.erase(instance);
            log::debug("players: +#{} {:#x}{} side {}", entry->id, instance, entry->local ? " (local)" : "",
                       static_cast<int>(entry->side));
            entries_.emplace(instance, std::move(*entry));
        } else {
            if (++failure.attempts == kMaxFreeBuildAttempts)
                log::debug("players: {:#x} ({}) failed to build {} times, backing off", instance,
                           game_.managed.classNameOf(instance), failure.attempts);
            failure.last = now;
        }
    }
    if (!list.empty()) buildCursor_ = (buildCursor_ + std::max<std::size_t>(1, inspected)) % list.size();
    std::erase_if(failures_, [&](const auto& kv) { return !registered_.contains(kv.first); });

    // Local flag follows GameWorld.MainPlayer (it can change, e.g. after death).
    for (auto& [instance, e] : entries_) {
        e.local = instance == roster->localPlayer;
        e.ai = !e.local;
    }

    // Players that left the list: mark absent after a few misses (dead players stay dead).
    for (auto& [instance, e] : entries_) {
        if (registered_.contains(instance)) {
            e.misses = 0;
            e.missingSince.reset();
            e.absent = false;
            continue;
        }
        if (e.dead || e.local) continue;
        ++e.misses;
        if (!e.missingSince) e.missingSince = now;
        if (e.misses >= kAbsentMisses && now - *e.missingSince >= kAbsentAfter) e.absent = true;
    }

    refresh(now);
    publish();
    publishRefs();
}

void Players::publishRefs() {
    std::vector<Ref> refs;
    refs.reserve(entries_.size());
    for (const auto& [instance, e] : entries_) refs.push_back({e.id, instance, e.dead});
    std::sort(refs.begin(), refs.end(), [](const Ref& a, const Ref& b) { return a.id < b.id; });
    if (refs == lastRefs_) return;
    lastRefs_ = refs;
    refs_.publish(std::move(refs));
}

std::vector<ItemNode> Players::readEquipment(Address player) const {
    const Address controller = readPointer(game_, player + off::Player::_inventoryController);
    const Address inventory = controller ? readPointer(game_, controller + off::InventoryController::Inventory) : 0;
    const Address equipment = inventory ? readPointer(game_, inventory + off::Inventory::Equipment) : 0;
    if (!equipment) return {};
    ItemTreeReader reader(game_);
    return reader.readSlots(readPointer(game_, equipment + off::InventoryEquipment::_cachedSlots));
}

void Players::equipmentTick(Clock::time_point now) {
    const auto refs = refs_.get();
    std::erase_if(equipment_, [&](const auto& kv) {
        return std::none_of(refs->begin(), refs->end(), [&](const Ref& r) { return r.id == kv.first; });
    });

    // Least recently read first; dead players keep their last equipment (their corpse's loot entry
    // has the current contents).
    std::vector<const Ref*> due;
    for (const Ref& r : *refs) {
        const auto it = equipment_.find(r.id);
        if (r.dead && it != equipment_.end() && it->second.read) continue;
        if (it == equipment_.end() || !it->second.read || now - it->second.lastRead >= kEquipmentRefresh) due.push_back(&r);
    }
    std::sort(due.begin(), due.end(), [&](const Ref* a, const Ref* b) {
        return equipment_[a->id].lastRead < equipment_[b->id].lastRead;
    });

    bool changed = false;
    for (std::size_t i = 0; i < std::min(kEquipmentPerTick, due.size()); ++i) {
        EquipmentState& state = equipment_[due[i]->id];
        auto slots = readEquipment(due[i]->instance);
        state.lastRead = now;
        state.read = true;
        if (slots != state.slots) {
            state.slots = std::move(slots);
            changed = true;
        }
    }
    if (!changed) return;

    EquipmentSnapshot snap;
    snap.raidId = session_->id;
    snap.revision = ++equipmentRevision_;
    for (const auto& [id, state] : equipment_)
        if (!state.slots.empty()) snap.players.push_back({id, state.slots});
    std::sort(snap.players.begin(), snap.players.end(), [](const auto& a, const auto& b) { return a.playerId < b.playerId; });
    world_.equipment.publish(std::move(snap));
}

void Players::refresh(Clock::time_point now) {
    struct Pending {
        Entry* entry = nullptr;
        Vec2 rotation{};
        Address corpse = 0;
        mem::ReadBatch::Handle rotationHandle = 0;
        std::optional<mem::ReadBatch::Handle> corpseHandle;
    };
    std::vector<Pending> pending;
    pending.reserve(entries_.size());
    for (auto& [instance, e] : entries_)
        if (!e.dead && registered_.contains(instance)) {
            Pending p;
            p.entry = &e;
            pending.push_back(p);
        }

    mem::ReadBatch batch(game_.mem);
    for (auto& p : pending) {
        p.rotationHandle = batch.add(p.entry->rotationField, p.rotation);
        if (now >= p.entry->nextCorpseCheck) {
            p.corpseHandle = batch.add(p.entry->corpseField, p.corpse);
            p.entry->nextCorpseCheck = now + kCorpseInterval;
        }
    }
    batch.execute(Freshness::Fresh);

    for (auto& p : pending) {
        if (batch.complete(p.rotationHandle) && std::isfinite(p.rotation.x) && std::isfinite(p.rotation.y)) {
            p.entry->yaw = p.rotation.x;
            p.entry->pitch = p.rotation.y;
        }
        if (p.corpseHandle && batch.complete(*p.corpseHandle) && MemoryView::isUserPointer(p.corpse)) {
            p.entry->dead = true;
            log::debug("players: #{} died", p.entry->id);
        }
    }
}

void Players::positionsTick(Clock::time_point now) {
    // Resolve missing bone pointers (rate-limited per player after a failure).
    std::vector<Entry*> tracked;
    for (auto& [instance, e] : entries_) {
        if (e.dead || e.absent) continue;
        if (!e.bones && now >= e.nextBoneResolve) {
            e.bones = resolvePositionBones(game_, instance);
            if (!e.bones) e.nextBoneResolve = now + kBoneRetry;
        }
        if (e.bones) tracked.push_back(&e);
    }
    if (tracked.empty()) return;

    // One batched transform read for every tracked player's bones.
    std::vector<Address> transforms;
    transforms.reserve(tracked.size() * 3);
    for (const Entry* e : tracked) transforms.insert(transforms.end(), e->bones->transforms.begin(), e->bones->transforms.end());
    const auto poses = game_.transforms.worldPoses(transforms, Freshness::Fresh);

    bool changed = false;
    for (std::size_t i = 0; i < tracked.size(); ++i) {
        Entry& e = *tracked[i];
        const std::array<std::optional<unity::Pose>, 3> mine{poses[i * 3], poses[i * 3 + 1], poses[i * 3 + 2]};
        if (auto position = pickPosition(mine)) {
            e.position = position;
            changed = true;
        }
        if (!plausibleSkeleton(mine)) {
            // Stale bone pointers (e.g. the body was rebuilt): resolve again next tick.
            e.bones.reset();
            e.nextBoneResolve = now;
        }
    }
    if (changed) publish();
}

void Players::publish() {
    PlayersSnapshot snap;
    snap.raidId = session_->id;
    snap.revision = ++revision_;
    snap.players.reserve(entries_.size());
    for (const auto& [instance, e] : entries_) {
        snap.players.push_back(PlayerState{
            .id = e.id,
            .local = e.local,
            .ai = e.ai,
            .side = e.side,
            .dead = e.dead,
            .absent = e.absent,
            .position = e.position,
            .yaw = e.yaw,
            .pitch = e.pitch,
        });
    }
    std::sort(snap.players.begin(), snap.players.end(), [](const auto& a, const auto& b) { return a.id < b.id; });
    world_.players.publish(std::move(snap));
}

}  // namespace radar::eft
