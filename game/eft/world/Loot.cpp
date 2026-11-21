#include "game/eft/world/Loot.hpp"

#include "core/log/Log.hpp"
#include "core/text/Ascii.hpp"
#include "game/eft/Names.hpp"
#include "game/eft/Read.hpp"
#include "core/mem/ReadBatch.hpp"
#include "game/eft/items/ItemTree.hpp"

#include <eft_offsets.hpp>

#include <algorithm>
#include <span>
#include <cmath>

namespace radar::eft {

using mem::Freshness;
using mem::MemoryView;
using sched::Clock;

namespace {
// The battle-pass info documents ("item_barter_info_<topic>") carry the quest-item flag but are
// ordinary loot.
// TODO: this seems like the kind of thing that frontend should decide, backend should report facts
bool isInfoDocument(std::string_view objectName) {
    constexpr std::string_view kPrefix = "item_barter_info_";
    return objectName.size() > kPrefix.size() && text::startsWithIgnoreCase(objectName, kPrefix);
}

bool plausible(const math::Vec3& p) { return math::isPlausiblePosition(p); }
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
        std::vector<Address> objects;
        for (const auto& [a, e] : entries_)
            if (live_.contains(a)) objects.push_back(a);
        const auto classes = mem::readEach<Address>(game_.mem, objects, game_.managed.layout().objectKlass, Freshness::Fresh);
        for (std::size_t i = 0; i < objects.size(); ++i) {
            if (classes[i] && *classes[i] != entries_.at(objects[i]).klass) {
                entries_.erase(objects[i]);
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

std::expected<Loot::Resolved, Loot::Unresolved> Loot::resolveOne(Address instance) const {
    using std::unexpected;
    const auto native = game_.managed.nativePointer(instance);
    const auto gameObject = native ? game_.scene.gameObjectOf(*native) : std::nullopt;
    if (!gameObject) return unexpected(Unresolved::Retry);
    Resolved r;
    r.instance = instance;
    r.entry.klass = game_.managed.klassOf(instance).value_or(0);
    LootEntry& loot = r.entry.loot;
    loot.objectName = game_.scene.objectName(*gameObject);
    if (loot.objectName.empty()) return unexpected(Unresolved::Retry);
    if (text::containsIgnoreCase(loot.objectName, "script")) {
        return unexpected(Unresolved::Permanent);  // scripted interactive objects, not loot
    }

    const auto templateIdOf = [&](Address item) -> std::optional<std::string> {
        const Address tmpl = readPointer(game_, item + off::Item::Template);
        return tmpl ? readMongoId(game_, tmpl + off::ItemTemplate::_id) : std::nullopt;
    };

    // Yes / no / can't tell (part of the ancestry unreadable: try again later, it may be a LootItem).
    const auto klass = r.entry.klass;
    bool unknown = false;
    const auto is = [&](std::span<const std::string_view> names) {
        for (const auto name : names) {
            const auto match = game_.managed.classIsAKnown(klass, name);
            if (match.value_or(false)) return true;
            unknown |= !match.has_value();
        }
        return false;
    };

    if (is(kLootClassesCorpse)) {
        loot.kind = LootEntry::Kind::Corpse;
        r.entry.contentsRoot = readPointer(game_, instance + off::InteractiveLootItem::Item);
    } else if (is(kLootClassesContainer)) {
        if (text::containsIgnoreCase(loot.objectName, "loot_collider")) {
            loot.kind = LootEntry::Kind::Airdrop;
        } else {
            loot.kind = LootEntry::Kind::Container;
            const Address owner = readPointer(game_, instance + off::LootableContainer::ItemOwner);
            const Address root = owner ? readPointer(game_, owner + off::LootableContainerItemOwner::RootItem) : 0;
            auto id = root ? templateIdOf(root) : std::nullopt;
            if (!id) {
                log::debug("loot: container {:#x} '{}': no root item (owner {:#x}, root {:#x})", instance,
                           loot.objectName, owner, root);
                return unexpected(Unresolved::Retry);
            }
            loot.templateId = std::move(*id);
        }
    } else if (is(kLootClassesItem)) {
        const Address item = readPointer(game_, instance + off::InteractiveLootItem::Item);
        const Address tmpl = item ? readPointer(game_, item + off::Item::Template) : 0;
        auto id = tmpl ? readMongoId(game_, tmpl + off::ItemTemplate::_id) : std::nullopt;
        if (!id) return unexpected(Unresolved::Retry);
        loot.templateId = std::move(*id);
        const bool questItem =
            game_.mem.read<std::uint8_t>(tmpl + off::ItemTemplate::QuestItem) != 0 && !isInfoDocument(loot.objectName);
        loot.kind = questItem ? LootEntry::Kind::QuestItem : LootEntry::Kind::Item;
    } else {
        if (unknown) {
            if (unknownClassesLogged_.insert(klass).second)
                    log::debug("loot: {:#x}: can't tell whether it's loot yet (retrying; logged once per class), "
                           "ancestry {}", instance, game_.managed.describeAncestry(klass));
            return unexpected(Unresolved::Retry);
        }
        log::debug("loot: ignoring {:#x} of class {}", instance, game_.managed.describeAncestry(klass));
        return unexpected(Unresolved::Permanent);
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
    auto fail = [&](Address a, Unresolved why) {
        Failure& f = failures_[a];
        f.permanent = why == Unresolved::Permanent || ++f.attempts >= kMaxAttempts;
        f.nextTry = now + retryDelay(f.attempts);
    };
    for (Address a : todo) {
        if (auto r = resolveOne(a)) resolved.push_back(std::move(*r));
        else fail(a, r.error());
    }

    std::vector<Address> transforms;
    for (const auto& r : resolved) transforms.push_back(r.entry.transform);
    const auto poses = game_.transforms.worldPoses(transforms, Freshness::Cached);
    for (std::size_t i = 0; i < resolved.size(); ++i) {
        Resolved& r = resolved[i];
        if (!poses[i] || !plausible(poses[i]->position)) {
            fail(r.instance, Unresolved::Retry);
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
    auto contents = reader.readContents(e.contentsRoot);
    if (reader.truncated() && !loggedTruncation_) {
        loggedTruncation_ = true;
        log::debug("loot: contents of {:#x} cut at the item tree's node cap (first occurrence; others not logged)",
                   e.contentsRoot);
    }
    return contents;
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
