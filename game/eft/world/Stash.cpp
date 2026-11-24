#include "game/eft/world/Stash.hpp"

#include "core/log/Log.hpp"
#include "game/eft/Read.hpp"

#include <eft_offsets.hpp>

#include <algorithm>
#include <cctype>
#include <format>
#include <map>

namespace radar::eft {

using mem::Freshness;

namespace {

constexpr std::string_view kApplicationClass = "EFT.TarkovApplication";
constexpr std::string_view kSessionClass = "EFT.ClientBackendSession";

void tallyInto(const std::vector<ItemNode>& nodes, std::map<std::string, OwnedItem>& out) {
    for (const auto& n : nodes) {
        auto& o = out[n.tpl];
        o.count += n.count;
        if (n.fir) o.fir += n.count;
        tallyInto(n.children, out);
    }
}

std::int64_t units(const std::vector<OwnedItem>& items) {
    std::int64_t n = 0;
    for (const auto& o : items) n += o.count;
    return n;
}

std::int64_t firUnits(const std::vector<OwnedItem>& items) {
    std::int64_t n = 0;
    for (const auto& o : items) n += o.fir;
    return n;
}

std::vector<OwnedItem> sorted(std::map<std::string, OwnedItem>&& m) {
    std::vector<OwnedItem> out;
    out.reserve(m.size());
    for (auto& [tpl, o] : m) {
        o.tpl = tpl;
        out.push_back(std::move(o));
    }
    return out;
}

}  // namespace

Stash::Stash(std::shared_ptr<const RaidSession> session, WorldState& world)
    : session_(std::move(session)), game_(session_->game), world_(world) {}

Stash::~Stash() { world_.stash.publish(StashSnapshot{}); }

void Stash::registerTasks(sched::TaskRunner&, sched::TaskRunner& background) {
    background.add("stash", {.interval = kInterval, .phase = std::chrono::milliseconds(1500)}, [this] { update(); });
}

std::vector<OwnedItem> Stash::tally(const std::vector<ItemNode>& nodes) {
    std::map<std::string, OwnedItem> m;
    tallyInto(nodes, m);
    return sorted(std::move(m));
}

std::optional<Address> Stash::findApplication(const Game& game, std::size_t* checked) {
    const auto gom = game.gameObjectManager();
    if (!gom) return std::nullopt;
    const auto walk = game.scene.activeObjects(*gom);
    std::vector<Address> named, rest;
    for (Address o : walk.objects) {
        std::string name = game.scene.objectName(o);
        std::transform(name.begin(), name.end(), name.begin(), [](unsigned char c) { return char(std::tolower(c)); });
        (name.find("application") != std::string::npos ? named : rest).push_back(o);
    }
    std::size_t n = 0;
    std::optional<Address> found;
    for (const auto* pass : {&named, &rest}) {
        for (Address object : *pass) {
            ++n;
            const auto comps = game.scene.components(object);
            for (std::size_t i = 1; i < comps.size() && !found; ++i) {  // 0 is the Transform
                const auto managed = game.scene.managedObject(comps[i]);
                if (managed && game.managed.isInstanceOf(*managed, kApplicationClass)) found = *managed;
            }
            if (found) break;
        }
        if (found) break;
    }
    if (checked) *checked = n;
    return found;
}

Address Stash::profileOfSession(const Game& game, Address session) {
    if (!session || !game.managed.isInstanceOf(session, kSessionClass)) return 0;
    return readPointer(game, session + off::ClientBackendSession::Profile, Freshness::Fresh);
}

Address Stash::sessionProfile(const Game& game, Address application) {
    const Address backEnd = readPointer(game, application + off::ClientApplication::ClientBackEnd, Freshness::Fresh);
    return profileOfSession(game, backEnd ? readPointer(game, backEnd + off::ClientBackend::Session, Freshness::Fresh) : 0);
}

Address Stash::playerSessionProfile(const Game& game, Address localPlayer) {
    if (!localPlayer) return 0;
    return profileOfSession(game, readPointer(game, localPlayer + off::ClientPlayer::Session, Freshness::Fresh));
}

std::optional<Stash::Contents> Stash::readContents(const Game& game, Address profile) {
    const Address inventory = readPointer(game, profile + off::Profile::Inventory, Freshness::Fresh);
    if (!inventory) return std::nullopt;
    const auto field = [&](std::uint32_t offset) { return readPointer(game, inventory + offset, Freshness::Fresh); };
    const Address stash = field(off::Inventory::Stash);
    if (!stash) return std::nullopt;  // stripped: not the menu-side profile

    Contents c;
    c.profileId = game.managed.readStringField(profile + off::Profile::Id, 64).value_or("");
    // Every container, then the equipment, in one breadth-first read.
    std::vector<ItemRoot> roots{{ItemRoot::Kind::Contents, stash}};
    for (const std::uint32_t offset : {off::Inventory::SortingTable, off::Inventory::QuestStashItems})
        if (const Address container = field(offset)) roots.push_back({ItemRoot::Kind::Contents, container});
    // Dictionary<area, stash>: whatever the key, the value sits at the same entry offset.
    if (const Address dict = field(off::Inventory::HideoutAreaStashes))
        if (const auto areas = game.managed.readDictionary<std::uint64_t, Address>(dict, 256, Freshness::Fresh))
            for (const auto& [key, container] : *areas)
                if (container) roots.push_back({ItemRoot::Kind::Contents, container});
    const std::size_t containers = roots.size();
    if (const Address equipment = field(off::Inventory::Equipment))
        roots.push_back({ItemRoot::Kind::Slots, readPointer(game, equipment + off::InventoryEquipment::_cachedSlots)});

    ItemTreeReader reader(game, kLimits);
    const auto trees = reader.read(roots);
    std::map<std::string, OwnedItem> owned;
    for (std::size_t i = 0; i < containers; ++i) tallyInto(trees[i], owned);
    c.stash = sorted(std::move(owned));
    if (trees.size() > containers) c.equipment = tally(trees[containers]);
    c.truncated = reader.truncated();
    c.unreadable = reader.failures();
    return c;
}

void Stash::update() {
    const Address profile = playerSessionProfile(game_, session_->start.localPlayer);
    auto contents = profile ? readContents(game_, profile) : std::nullopt;
    if (!contents) {
        if (!loggedFailure_)
            log::info("stash: not readable (local player {:#x}, session profile {:#x}); trying again every {} s",
                      session_->start.localPlayer, profile, kInterval.count());
        loggedFailure_ = true;
        return;  // keep the last good one
    }
    // An incomplete read would drop owned items (or count stacks as 1), making them "needed": keep the
    // last complete one (or none: the frontend then uses the stash it kept from earlier).
    if (contents->unreadable > 0) {
        log::info("stash: {} read(s) failed, keeping the {}; trying again in {} s", contents->unreadable,
                  last_ ? "last complete read" : "frontend's kept stash", kInterval.count());
        return;
    }
    loggedFailure_ = false;
    if (contents->truncated) log::info("stash: item tree cut at {} items", kLimits.maxNodes);
    if (contents == last_) return;
    log::info("stash: {} templates, {} units ({} FIR), {} in the equipment{}", contents->stash.size(),
              units(contents->stash), firUnits(contents->stash), contents->equipment.size(),
              last_ ? std::format(" (was {} templates, {} units)", last_->stash.size(), units(last_->stash)) : "");
    world_.stash.publish(StashSnapshot{.raidId = session_->id, .revision = ++revision_, .known = true,
                                       .profileId = contents->profileId, .stash = contents->stash,
                                       .equipment = contents->equipment});
    last_ = std::move(contents);
}

}  // namespace radar::eft
