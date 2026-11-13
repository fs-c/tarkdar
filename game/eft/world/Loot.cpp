#include "game/eft/world/Loot.hpp"

#include "core/log/Log.hpp"
#include "game/eft/Names.hpp"
#include "game/eft/Read.hpp"
#include "core/mem/ReadBatch.hpp"
#include "game/eft/items/ItemTree.hpp"

#include <eft_offsets.hpp>

#include <algorithm>
#include <cctype>
#include <cmath>

namespace radar::eft {

using mem::Freshness;
using mem::MemoryView;
using sched::Clock;

namespace {
bool containsIgnoreCase(std::string_view haystack, std::string_view needle) {
    return std::search(haystack.begin(), haystack.end(), needle.begin(), needle.end(), [](char a, char b) {
               return std::tolower(static_cast<unsigned char>(a)) == std::tolower(static_cast<unsigned char>(b));
           }) != haystack.end();
}

bool plausible(const math::Vec3& p) {
    return math::isSane(p) && !(p.x == 0.0f && p.y == 0.0f && p.z == 0.0f);
}
}  // namespace

Loot::Loot(std::shared_ptr<const RaidSession> session, WorldState& world)
    : session_(std::move(session)), game_(session_->game), world_(world) {}

Loot::~Loot() { world_.loot.publish(LootSnapshot{}); }

void Loot::registerTasks(sched::TaskRunner&, sched::TaskRunner& background) {
    background.add("loot.scan", {.interval = kScanInterval, .phase = std::chrono::milliseconds(50), .runOnStart = true},
                   [this] { scan(Clock::now()); });
    background.add("loot.resolve", {.interval = kResolveInterval, .phase = std::chrono::milliseconds(120)},
                   [this] { resolve(Clock::now()); });
}

void Loot::scan(Clock::time_point now) {
    const Address list = readPointer(game_, session_->start.localGameWorld + off::ClientLocalGameWorld::LootList,
                                     Freshness::Fresh);
    const auto items = list ? game_.managed.readList<Address>(list, kMaxEntries, Freshness::Fresh) : std::nullopt;
    if (!items) return;

    live_.clear();
    for (Address a : *items)
        if (MemoryView::isUserPointer(a)) live_.insert(a);

    // Removal, with a guard against torn reads wiping the cache.
    const bool suspicious = entries_.size() >= 32 && live_.size() < entries_.size() / 2;
    for (auto it = entries_.begin(); it != entries_.end();) {
        Entry& e = it->second;
        if (live_.contains(it->first) || suspicious) {
            e.misses = 0;
        } else if (++e.misses >= kMissesToRemove) {
            it = entries_.erase(it);
            dirty_ = true;
            continue;
        }
        ++it;
    }
    // Address reuse: an entry whose class changed is now a different object.
    {
        std::vector<std::pair<Address, Address>> classes;
        for (const auto& [a, e] : entries_)
            if (live_.contains(a)) classes.emplace_back(a, 0);
        mem::ReadBatch batch(game_.mem);
        for (auto& [a, klass] : classes) batch.add(a + game_.managed.layout().objectKlass, klass);
        batch.execute(Freshness::Fresh);
        for (std::size_t i = 0; i < classes.size(); ++i) {
            const auto& [a, klass] = classes[i];
            if (batch.complete(i) && klass != entries_.at(a).klass) {
                entries_.erase(a);
                dirty_ = true;
            }
        }
    }
    std::erase_if(pending_, [&](Address a) { return !live_.contains(a); });
    std::erase_if(failures_, [&](const auto& kv) { return !live_.contains(kv.first); });
    for (Address a : live_)
        if (!entries_.contains(a)) pending_.insert(a);

    refreshAirdrops();
    refreshContents();
    resolve(now);
    if (dirty_) publish();
}

std::optional<Loot::Resolved> Loot::resolveOne(Address instance, bool& permanent) const {
    permanent = false;
    const auto native = game_.managed.nativePointer(instance);
    const auto gameObject = native ? game_.scene.gameObjectOf(*native) : std::nullopt;
    if (!gameObject) return std::nullopt;
    Resolved r;
    r.instance = instance;
    r.entry.klass = game_.managed.klassOf(instance).value_or(0);
    LootEntry& loot = r.entry.loot;
    loot.objectName = game_.scene.objectName(*gameObject);
    if (loot.objectName.empty()) return std::nullopt;
    if (containsIgnoreCase(loot.objectName, "script")) {
        permanent = true;  // scripted interactive objects, not loot
        return std::nullopt;
    }

    const auto templateIdOf = [&](Address item) -> std::optional<std::string> {
        const Address tmpl = readPointer(game_, item + off::Item::Template);
        return tmpl ? readMongoId(game_, tmpl + off::ItemTemplate::_id) : std::nullopt;
    };

    if (game_.managed.isInstanceOf(instance, kLootClassCorpse)) {
        loot.kind = LootEntry::Kind::Corpse;
        r.entry.contentsRoot = readPointer(game_, instance + off::InteractiveLootItem::Item);
    } else if (game_.managed.isInstanceOf(instance, kLootClassContainer)) {
        if (containsIgnoreCase(loot.objectName, "loot_collider")) {
            loot.kind = LootEntry::Kind::Airdrop;
        } else {
            loot.kind = LootEntry::Kind::Container;
            const Address owner = readPointer(game_, instance + off::LootableContainer::ItemOwner);
            const Address root = owner ? readPointer(game_, owner + off::LootableContainerItemOwner::RootItem) : 0;
            auto id = root ? templateIdOf(root) : std::nullopt;
            if (!id) {
                log::debug("loot: container {:#x} '{}': no root item (owner {:#x}, root {:#x})", instance,
                           loot.objectName, owner, root);
                return std::nullopt;
            }
            loot.templateId = std::move(*id);
        }
    } else if (game_.managed.isInstanceOf(instance, kLootClassItem)) {
        const Address item = readPointer(game_, instance + off::InteractiveLootItem::Item);
        const Address tmpl = item ? readPointer(game_, item + off::Item::Template) : 0;
        auto id = tmpl ? readMongoId(game_, tmpl + off::ItemTemplate::_id) : std::nullopt;
        if (!id) return std::nullopt;
        loot.templateId = std::move(*id);
        loot.kind = game_.mem.read<std::uint8_t>(tmpl + off::ItemTemplate::QuestItem) != 0 ? LootEntry::Kind::QuestItem
                                                                                            : LootEntry::Kind::Item;
    } else {
        permanent = true;
        log::debug("loot: ignoring {:#x} of class {}", instance, game_.managed.classNameOf(instance));
        return std::nullopt;
    }
    r.entry.transform = game_.scene.transform(*gameObject).value_or(0);
    loot.contents = readContents(r.entry);
    return r;
}

void Loot::resolve(Clock::time_point now) {
    std::vector<Address> todo;
    for (Address a : pending_) {
        if (todo.size() >= kResolvePerTick) break;
        const auto f = failures_.find(a);
        if (f != failures_.end() && (f->second.permanent || now < f->second.nextTry)) continue;
        todo.push_back(a);
    }
    if (todo.empty()) return;

    std::vector<Resolved> resolved;
    auto fail = [&](Address a, bool permanent) {
        Failure& f = failures_[a];
        f.permanent = permanent || ++f.attempts >= kMaxAttempts;
        f.nextTry = now + std::min(std::chrono::seconds(20), std::chrono::seconds(2) * f.attempts);
    };
    for (Address a : todo) {
        bool permanent = false;
        if (auto r = resolveOne(a, permanent)) resolved.push_back(std::move(*r));
        else fail(a, permanent);
    }

    std::vector<Address> transforms;
    for (const auto& r : resolved) transforms.push_back(r.entry.transform);
    const auto poses = game_.transforms.worldPoses(transforms, Freshness::Cached);
    for (std::size_t i = 0; i < resolved.size(); ++i) {
        Resolved& r = resolved[i];
        if (!poses[i] || !plausible(poses[i]->position)) {
            fail(r.instance, false);
            continue;
        }
        r.entry.loot.position = poses[i]->position;
        r.entry.loot.id = nextId_++;
        pending_.erase(r.instance);
        failures_.erase(r.instance);
        entries_.emplace(r.instance, std::move(r.entry));
        dirty_ = true;
    }
    if (dirty_) publish();
}

void Loot::refreshAirdrops() {
    std::vector<Entry*> drops;
    std::vector<Address> transforms;
    for (auto& [a, e] : entries_) {
        if (e.loot.kind != LootEntry::Kind::Airdrop || !e.transform) continue;
        drops.push_back(&e);
        transforms.push_back(e.transform);
    }
    const auto poses = game_.transforms.worldPoses(transforms, Freshness::Fresh);
    for (std::size_t i = 0; i < drops.size(); ++i) {
        if (poses[i] && plausible(poses[i]->position) && !(poses[i]->position == drops[i]->loot.position)) {
            drops[i]->loot.position = poses[i]->position;
            dirty_ = true;
        }
    }
}

std::vector<ItemNode> Loot::readContents(const Entry& e) const {
    if (!e.contentsRoot) return {};
    ItemTreeReader reader(game_);
    return reader.readContents(e.contentsRoot);
}

void Loot::refreshContents() {
    std::vector<Entry*> withContents;
    for (auto& [a, e] : entries_)
        if (e.contentsRoot) withContents.push_back(&e);
    if (withContents.empty()) return;
    std::sort(withContents.begin(), withContents.end(), [](const Entry* x, const Entry* y) { return x->loot.id < y->loot.id; });
    const std::size_t n = std::min(kContentRefreshPerScan, withContents.size());
    for (std::size_t i = 0; i < n; ++i) {
        Entry& e = *withContents[(contentCursor_ + i) % withContents.size()];
        auto contents = readContents(e);
        if (contents != e.loot.contents) {
            e.loot.contents = std::move(contents);
            dirty_ = true;
        }
    }
    contentCursor_ = (contentCursor_ + n) % withContents.size();
}

void Loot::publish() {
    dirty_ = false;
    LootSnapshot snap;
    snap.raidId = session_->id;
    snap.revision = ++revision_;
    snap.loot.reserve(entries_.size());
    for (const auto& [a, e] : entries_) snap.loot.push_back(e.loot);
    std::sort(snap.loot.begin(), snap.loot.end(), [](const auto& x, const auto& y) { return x.id < y.id; });
    world_.loot.publish(std::move(snap));
}

}  // namespace radar::eft
