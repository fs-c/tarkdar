#include "game/eft/world/Explosives.hpp"

#include "core/mem/ReadBatch.hpp"
#include "game/eft/Read.hpp"

#include <eft_offsets.hpp>

#include <algorithm>
#include <cmath>
#include <unordered_set>

namespace radar::eft {

using mem::Freshness;
using mem::MemoryView;
using math::Vec3;

namespace {
// Finite, within ±100 km, and not at the world origin (zero-filled memory).
bool plausible(Vec3 p) {
    return math::isSane(p, 100000.0f) &&
           !(std::fabs(p.x) <= 1e-4f && std::fabs(p.y) <= 1e-4f && std::fabs(p.z) <= 1e-4f);
}

std::vector<Address> distinctValid(const std::vector<Address>& in) {
    std::vector<Address> out;
    std::unordered_set<Address> seen;
    for (Address a : in)
        if (MemoryView::isUserPointer(a) && seen.insert(a).second) out.push_back(a);
    return out;
}
}  // namespace

Explosives::Explosives(std::shared_ptr<const RaidSession> session, WorldState& world)
    : session_(std::move(session)), game_(session_->game), world_(world) {}

Explosives::~Explosives() { world_.explosives.publish(ExplosivesSnapshot{}); }

void Explosives::registerTasks(sched::TaskRunner& live, sched::TaskRunner&) {
    live.add("explosives.grenades", {.interval = kGrenadeInterval, .phase = std::chrono::milliseconds(3)},
             [this] { updateGrenades(); });
    live.add("explosives.tripwires", {.interval = kTripwireInterval, .phase = std::chrono::milliseconds(7)},
             [this] { updateTripwires(); });
}

void Explosives::updateGrenades() {
    const Address collection =
        readPointer(game_, session_->start.localGameWorld + off::ClientLocalGameWorld::Grenades, Freshness::Fresh);
    const auto list = collection ? game_.managed.readList<Address>(readPointer(game_, collection + off::GrenadeCollection::List,
                                                                               Freshness::Fresh),
                                                                   kMaxObjects, Freshness::Fresh)
                                 : std::nullopt;
    if (!list) return;
    const auto current = distinctValid(*list);
    const std::unordered_set<Address> present(current.begin(), current.end());

    bool changed = std::erase_if(grenades_, [&](const auto& kv) { return !present.contains(kv.first); }) > 0;
    std::erase_if(destroyed_, [&](Address g) { return !present.contains(g); });
    for (Address g : current)
        if (!grenades_.contains(g) && !destroyed_.contains(g)) grenades_.emplace(g, GrenadeEntry{.id = nextId_++, .transform = 0, .position = std::nullopt});

    // Destroyed flags, then positions of the live ones.
    std::vector<std::pair<Address, std::uint8_t>> destroyed;
    for (const auto& [g, e] : grenades_) destroyed.emplace_back(g, 0);
    mem::ReadBatch batch(game_.mem);
    for (auto& [g, flag] : destroyed) batch.add(g + off::Throwable::_isDestroyed, flag);
    batch.execute(Freshness::Fresh);
    for (const auto& [g, flag] : destroyed) {
        if (flag == 0) continue;
        changed |= grenades_.erase(g) > 0;
        destroyed_.insert(g);
    }

    std::vector<GrenadeEntry*> live;
    std::vector<Address> transforms;
    for (auto& [g, e] : grenades_) {
        if (!e.transform) e.transform = transformOfComponent(game_, g).value_or(0);
        if (!e.transform) continue;
        live.push_back(&e);
        transforms.push_back(e.transform);
    }
    const auto poses = game_.transforms.worldPoses(transforms, Freshness::Fresh);
    for (std::size_t i = 0; i < live.size(); ++i) {
        if (poses[i] && plausible(poses[i]->position) && live[i]->position != poses[i]->position) {
            live[i]->position = poses[i]->position;
            changed = true;
        }
    }
    if (changed) publish();
}

void Explosives::updateTripwires() {
    const Address processor = readPointer(
        game_, session_->start.localGameWorld + off::GameWorld::SynchronizableObjectLogicProcessor, Freshness::Fresh);
    if (!processor) return;
    const Address active = readPointer(
        game_, processor + off::SynchronizableObjectLogicProcessor::_activeSynchronizableObjects, Freshness::Fresh);
    const Address statics = readPointer(
        game_, processor + off::SynchronizableObjectLogicProcessor::_staticSynchronizableObjects, Freshness::Fresh);
    std::vector<Address> candidates;
    for (Address list : {active, statics == active ? Address{0} : statics}) {
        if (!list) continue;
        auto items = game_.managed.readList<Address>(list, kMaxObjects, Freshness::Fresh);
        if (!items) return;  // torn read: try again next tick
        candidates.insert(candidates.end(), items->begin(), items->end());
    }
    candidates = distinctValid(candidates);

    // Type, then state and endpoints of the tripwires.
    std::vector<std::int32_t> types(candidates.size());
    mem::ReadBatch typeBatch(game_.mem);
    for (std::size_t i = 0; i < candidates.size(); ++i)
        typeBatch.add(candidates[i] + off::SynchronizableObject::Type, types[i]);
    typeBatch.execute(Freshness::Fresh);

    struct Wire {
        Address object;
        std::int32_t state = 0;
        Vec3 from, to;
    };
    std::vector<Wire> wires;
    for (std::size_t i = 0; i < candidates.size(); ++i)
        if (typeBatch.complete(i) && types[i] == kTripwireType) wires.push_back(Wire{.object = candidates[i], .state = 0, .from = {}, .to = {}});
    if (wires.size() > kMaxObjects) return;
    mem::ReadBatch batch(game_.mem);
    for (auto& w : wires) {
        batch.add(w.object + off::TripwireSynchronizableObject::_tripwireState, w.state);
        batch.add(w.object + off::TripwireSynchronizableObject::FromPosition, w.from);
        batch.add(w.object + off::TripwireSynchronizableObject::ToPosition, w.to);
    }
    batch.execute(Freshness::Fresh);

    std::unordered_map<Address, Tripwire> next;
    for (std::size_t i = 0; i < wires.size(); ++i) {
        Wire& w = wires[i];
        const bool read = batch.complete(i * 3) && batch.complete(i * 3 + 1) && batch.complete(i * 3 + 2);
        if (!read || (w.state != kTripwireWait && w.state != kTripwireActive)) continue;
        w.from.y += kTripwireYOffset;
        w.to.y += kTripwireYOffset;
        if (!plausible(w.from) || !plausible(w.to)) continue;
        const auto old = tripwires_.find(w.object);
        next.emplace(w.object, Tripwire{.id = old != tripwires_.end() ? old->second.id : nextId_++, .from = w.from, .to = w.to});
    }
    const bool changed = next.size() != tripwires_.size() ||
                         std::any_of(next.begin(), next.end(), [&](const auto& kv) {
                             const auto it = tripwires_.find(kv.first);
                             return it == tripwires_.end() || !(it->second.from == kv.second.from) ||
                                    !(it->second.to == kv.second.to);
                         });
    tripwires_ = std::move(next);
    if (changed) publish();
}

void Explosives::publish() {
    ExplosivesSnapshot snap;
    snap.raidId = session_->id;
    snap.revision = ++revision_;
    for (const auto& [g, e] : grenades_)
        if (e.position) snap.grenades.push_back({e.id, *e.position});
    for (const auto& [t, wire] : tripwires_) snap.tripwires.push_back(wire);
    std::sort(snap.grenades.begin(), snap.grenades.end(), [](const auto& a, const auto& b) { return a.id < b.id; });
    std::sort(snap.tripwires.begin(), snap.tripwires.end(), [](const auto& a, const auto& b) { return a.id < b.id; });
    world_.explosives.publish(std::move(snap));
}

}  // namespace radar::eft
