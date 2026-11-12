#include "game/eft/players/Players.hpp"

#include "core/log/Log.hpp"
#include "core/mem/ReadBatch.hpp"
#include "game/eft/items/ItemTree.hpp"
#include "game/eft/raid/Roster.hpp"

#include "game/eft/Read.hpp"

#include <eft_offsets.hpp>

#include <algorithm>
#include <cmath>
#include <format>

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
        const bool isLocal = instance == roster->localPlayer;
        if (auto layout = buildPlayerLayout(game_, instance, isLocal)) {
            Entry entry;
            entry.id = nextId_++;
            entry.instance = instance;
            entry.local = isLocal;
            entry.layout = std::move(*layout);
            failures_.erase(instance);
            log::debug("players: +#{} {:#x} {} ({}) side {} ai {}{}{} nick '{}' group '{}'", entry.id, instance,
                       kindName(entry.layout.kind), entry.layout.className, static_cast<int>(entry.layout.side),
                       entry.layout.ai, entry.layout.voice.empty() ? "" : " voice " + entry.layout.voice,
                       entry.layout.role ? std::format(" role {}", *entry.layout.role) : "", entry.layout.nickname,
                       entry.layout.groupId);
            entries_.emplace(instance, std::move(entry));
        } else {
            failure.error = std::move(layout.error());
            failure.className = game_.managed.classNameOf(instance);
            if (++failure.attempts == kMaxFreeBuildAttempts)
                log::info("players: {:#x} ({}) failed to build {} times, backing off: {}", instance,
                          failure.className, failure.attempts, failure.error);
            failure.last = now;
        }
    }
    if (!list.empty()) buildCursor_ = (buildCursor_ + std::max<std::size_t>(1, inspected)) % list.size();
    std::erase_if(failures_, [&](const auto& kv) { return !registered_.contains(kv.first); });

    // Observed players whose AI data wasn't set up at build time: try again for a while.
    for (auto& [instance, e] : entries_) {
        if (e.layout.kind != PlayerKind::Observed || e.layout.role || e.roleAttempts >= kMaxRoleAttempts ||
            now < e.nextRoleRead || !registered_.contains(instance))
            continue;
        ++e.roleAttempts;
        e.nextRoleRead = now + kRoleRetry;
        if ((e.layout.role = readObservedRole(game_, instance)))
            log::debug("players: #{} role {} (after {} attempts)", e.id, *e.layout.role, e.roleAttempts);
    }

    // Local flag follows GameWorld.MainPlayer (it can change, e.g. after death). Full Players other
    // than ours are local bots; observed players keep the flag they were built with.
    for (auto& [instance, e] : entries_) {
        e.local = instance == roster->localPlayer;
        if (e.layout.kind == PlayerKind::Observed) continue;
        e.layout.kind = e.local ? PlayerKind::Local : PlayerKind::Client;
        e.layout.ai = !e.local;
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
    for (const auto& [instance, e] : entries_) refs.push_back({e.id, e.layout.inventoryControllerField, e.dead});
    std::sort(refs.begin(), refs.end(), [](const Ref& a, const Ref& b) { return a.id < b.id; });
    if (refs == lastRefs_) return;
    lastRefs_ = refs;
    refs_.publish(std::move(refs));
}

std::vector<Players::BuildFailureInfo> Players::buildFailures() const {
    std::vector<BuildFailureInfo> out;
    for (const auto& [instance, f] : failures_)
        if (f.attempts > 0) out.push_back({instance, f.className, f.error, f.attempts});
    std::sort(out.begin(), out.end(), [](const auto& a, const auto& b) { return a.instance < b.instance; });
    return out;
}

std::vector<ItemNode> Players::readEquipment(Address inventoryControllerField) const {
    const Address controller = readPointer(game_, inventoryControllerField);
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
        auto slots = readEquipment(due[i]->inventoryControllerField);
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
        p.rotationHandle = batch.add(p.entry->layout.rotationField, p.rotation);
        if (now >= p.entry->nextCorpseCheck) {
            p.corpseHandle = batch.add(p.entry->layout.corpseField, p.corpse);
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
            e.bones = resolveSkeletonBones(game_, e.layout.bodyField);
            if (!e.bones) e.nextBoneResolve = now + kBoneRetry;
        }
        if (e.bones) tracked.push_back(&e);
    }
    if (tracked.empty()) return;

    // One batched transform read for every tracked player's bones. A player's bones share one
    // transform hierarchy, so the extra joints cost little more than the position bones.
    std::vector<Address> transforms;
    transforms.reserve(tracked.size() * kJointCount);
    for (const Entry* e : tracked) transforms.insert(transforms.end(), e->bones->used().begin(), e->bones->used().end());
    const auto poses = game_.transforms.worldPoses(transforms, Freshness::Fresh);

    bool changed = false;
    std::size_t at = 0;
    for (Entry* ep : tracked) {
        Entry& e = *ep;
        const std::span<const std::optional<unity::Pose>> mine{poses.data() + at, e.bones->count()};
        at += mine.size();
        const std::array<std::optional<unity::Pose>, 3> positionPoses{mine[0], mine[1], mine[2]};
        if (auto position = pickPosition(positionPoses)) {
            e.position = position;
            e.joints = e.bones->full ? relativeJoints(mine, *position) : std::nullopt;
            changed = true;
        }
        if (!plausibleSkeleton(positionPoses)) {
            // Stale bone pointers (e.g. the body was rebuilt): resolve again next tick.
            e.bones.reset();
            e.joints.reset();
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
            .kind = e.layout.kind,
            .ai = e.layout.ai,
            .side = e.layout.side,
            .dead = e.dead,
            .absent = e.absent,
            .voice = e.layout.voice,
            .role = e.layout.role,
            .nickname = e.layout.nickname,
            .groupId = e.layout.groupId,
            .position = e.position,
            .yaw = e.yaw,
            .pitch = e.pitch,
            .joints = e.joints,
        });
    }
    std::sort(snap.players.begin(), snap.players.end(), [](const auto& a, const auto& b) { return a.id < b.id; });
    world_.players.publish(std::move(snap));
}

}  // namespace radar::eft
