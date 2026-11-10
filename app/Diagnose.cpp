#include "app/Diagnose.hpp"

#include "game/eft/BuildCheck.hpp"
#include "game/eft/Game.hpp"
#include "game/eft/Read.hpp"
#include "game/eft/model/WorldState.hpp"
#include "game/eft/players/Players.hpp"
#include "game/eft/raid/RaidFinder.hpp"
#include "game/eft/raid/Roster.hpp"
#include "game/eft/world/Exfils.hpp"
#include "game/eft/world/Explosives.hpp"
#include "game/eft/world/Loot.hpp"

#include <eft_offsets.hpp>

#include <chrono>
#include <format>
#include <map>
#include <string>
#include <thread>

namespace radar::app {

namespace {

using mem::Address;
using sched::Clock;

class Report {
public:
    explicit Report(std::FILE* out) : out_(out) {}

    void section(std::string_view title) { std::fprintf(out_, "\n== %.*s ==\n", int(title.size()), title.data()); }
    void ok(std::string_view msg) { line("  OK  ", msg); }
    void fail(std::string_view msg, std::string_view hint = {}) {
        ++failures_;
        line("  FAIL", msg);
        if (!hint.empty()) line("      ", std::format("check: {}", hint));
    }
    void info(std::string_view msg) { line("      ", msg); }
    [[nodiscard]] int failures() const { return failures_; }

private:
    void line(std::string_view tag, std::string_view msg) {
        std::fprintf(out_, "%.*s %.*s\n", int(tag.size()), tag.data(), int(msg.size()), msg.data());
        std::fflush(out_);
    }
    std::FILE* out_;
    int failures_ = 0;
};

std::string hex(Address a) { return std::format("{:#x}", a); }

std::string classOf(const eft::Game& game, Address object) {
    const auto klass = game.managed.klassOf(object);
    const auto name = klass ? game.managed.fullClassName(*klass) : std::string{};
    return name.empty() ? "?" : name;
}

const char* statusName(eft::WorldCheck::Status s) {
    switch (s) {
    case eft::WorldCheck::Status::Ready: return "ready";
    case eft::WorldCheck::Status::Pending: return "pending";
    case eft::WorldCheck::Status::Rejected: return "rejected";
    }
    return "?";
}

std::size_t countNodes(const std::vector<eft::ItemNode>& nodes) {
    std::size_t n = nodes.size();
    for (const auto& c : nodes) n += countNodes(c.children);
    return n;
}

void checkIl2Cpp(Report& r, const eft::Game& game) {
    r.section("IL2CPP");
    const auto table = game.typeInfoTable();
    if (!table) {
        r.fail("type-info table not found at GameAssembly + " + hex(off::bootstrap::typeInfoTableRva),
               "bootstrap.typeInfoTableRva (regenerate with il2cpp-dump)");
        return;
    }
    r.ok("type-info table at " + hex(table->address()));
    const auto klass = table->klass(off::GamePlayerOwner::TypeIndex);
    if (!klass) {
        r.fail(std::format("type index {:#x} (GamePlayerOwner) has no class yet", off::GamePlayerOwner::TypeIndex),
               "GamePlayerOwner.TypeIndex; or the class isn't initialised yet (enter a raid)");
        return;
    }
    const auto name = game.managed.fullClassName(*klass);
    if (name == "EFT.GamePlayerOwner") r.ok("type index points at EFT.GamePlayerOwner");
    else r.fail("type index points at '" + name + "', expected EFT.GamePlayerOwner", "GamePlayerOwner.TypeIndex");
    const auto statics = table->staticFields(off::GamePlayerOwner::TypeIndex);
    if (!statics) {
        r.fail("GamePlayerOwner has no static fields block", "managedLayout.Il2CppClass.StaticFields");
        return;
    }
    const Address myPlayer = eft::readPointer(game, *statics + off::GamePlayerOwner::MyPlayer, mem::Freshness::Fresh);
    if (myPlayer) r.ok("GamePlayerOwner._myPlayer = " + hex(myPlayer) + " (" + classOf(game, myPlayer) + ")");
    else r.info("GamePlayerOwner._myPlayer is null (normal outside a raid)");
}

void checkUnity(Report& r, const eft::Game& game) {
    r.section("Unity");
    const auto gom = game.gameObjectManager();
    if (!gom) {
        r.fail("GameObjectManager pointer unreadable at UnityPlayer + " + hex(off::unity_rva::gameObjectManager),
               "unityRvas.gameObjectManager");
        return;
    }
    r.ok("GameObjectManager at " + hex(*gom));
    const auto walk = game.scene.activeObjects(*gom);
    const char* end = walk.end == unity::Scene::Walk::End::ReachedTail ? "reached tail"
                      : walk.end == unity::Scene::Walk::End::Cycle     ? "cycle"
                      : walk.end == unity::Scene::Walk::End::Cap       ? "hit the cap"
                      : walk.end == unity::Scene::Walk::End::BadHeader ? "bad list header"
                                                                       : "invalid next pointer";
    if (walk.objects.empty()) r.fail(std::format("active object list empty ({})", end), "unityLayout.GameObjectManager.*, ListNode.*");
    else r.ok(std::format("{} active objects ({})", walk.objects.size(), end));
    const auto named = game.scene.findByName(*gom, "GameWorld");
    r.info(std::format("{} object(s) named GameWorld (expected 1 in a raid)", named.size()));
}

std::optional<eft::RaidCandidate> checkRaid(Report& r, const eft::Game& game) {
    r.section("Raid discovery");
    eft::RaidFinder finder(game);
    std::optional<eft::RaidCandidate> found;
    auto describe = [&](std::string_view strategy, const std::optional<eft::WorldCheck>& wc) {
        if (!wc) {
            r.info(std::string(strategy) + ": no candidate world");
            return;
        }
        const auto& c = wc->candidate;
        const auto msg = std::format("{}: world {} → {} (location '{}', local player {}, {} registered){}{}", strategy,
                                     hex(c.localGameWorld), statusName(wc->status), c.locationId, hex(c.localPlayer),
                                     c.registeredCount, wc->reason.empty() ? "" : ": ", wc->reason);
        if (wc->status == eft::WorldCheck::Status::Ready) {
            r.ok(msg);
            if (!found) found = c;
        } else {
            r.info(msg);
        }
    };
    describe("GamePlayerOwner static", finder.viaGamePlayerOwner());
    describe("scene scan", finder.viaSceneScan());
    if (!found)
        r.fail("no raid found",
               "be in a raid; then GameWorld.Location, ClientLocalGameWorld.MainPlayer/RegisteredPlayers, "
               "and kRaidLocations in Maps.hpp for unknown locations");
    return found;
}

void checkPlayers(Report& r, const std::shared_ptr<const eft::RaidSession>& session) {
    r.section("Players");
    const auto& game = session->game;
    const auto roster = eft::readRoster(game, session->start.localGameWorld);
    if (!roster) {
        r.fail("roster unreadable", "ClientLocalGameWorld.RegisteredPlayers, managedLayout.List.*");
        return;
    }
    std::map<std::string, int> classes;
    for (Address p : roster->players) ++classes[classOf(game, p)];
    std::string classList;
    for (const auto& [name, n] : classes) classList += std::format("{}{} ×{}", classList.empty() ? "" : ", ", name, n);
    r.ok(std::format("{} registered players: {}", roster->players.size(), classList));
    if (roster->players.size() <= 1)
        r.info("only the local player is registered: normal right at raid start; if bots are already "
               "visible in game, ClientLocalGameWorld.RegisteredPlayers may point at the wrong list");

    eft::WorldState world;
    eft::Players players(session, world);
    const auto t = Clock::now();
    // A few roster ticks (builds are rate-limited per tick), then positions and equipment.
    for (int i = 0; i < 1 + int(roster->players.size()) / eft::Players::kMaxBuildsPerTick; ++i)
        players.rosterTick(t + std::chrono::milliseconds(20 * i));
    players.positionsTick(t);
    for (int i = 0; i < 1 + int(roster->players.size()); ++i) players.equipmentTick(t + std::chrono::seconds(i));
    const auto snap = world.players.get();
    std::map<std::string, int> kinds;
    for (const auto& p : snap->players) ++kinds[eft::kindName(p.kind)];
    std::string kindList;
    for (const auto& [name, n] : kinds) kindList += std::format("{}{} ×{}", kindList.empty() ? "" : ", ", name, n);
    if (snap->players.size() < roster->players.size())
        r.fail(std::format("only {} of {} players built ({})", snap->players.size(), roster->players.size(), kindList),
               "client/local players: Player.Profile → Profile.Info → PlayerInfo.Side, Player._playerBody, "
               "Player.MovementContext; observed players: ObservedPlayerView.*, ObservedPlayerController.*, "
               "ObservedMovementController.*; see the reasons below");
    else
        r.ok(std::format("{} players built ({})", snap->players.size(), kindList));
    for (const auto& f : players.buildFailures())
        r.info(std::format("not built: {} ({}): {}", hex(f.instance), f.className, f.error));

    int positioned = 0;
    for (const auto& p : snap->players) positioned += p.position ? 1 : 0;
    if (positioned == 0 && !snap->players.empty())
        r.fail("no player has a position",
               "literals PlayerBody.SkeletonRootJoint, Skeleton.Values; unityLayout.Transform*/TransformHierarchy.*");
    else
        r.ok(std::format("{} of {} players have a position", positioned, snap->players.size()));
    for (const auto& p : snap->players) {
        if (!p.local && &p - snap->players.data() > 4) continue;  // the local player + a few others
        r.info(std::format("#{} {}{} side {}{}{} {}: pos {} yaw {:.1f} pitch {:.1f}", p.id, eft::kindName(p.kind),
                           p.ai ? " ai" : "", static_cast<int>(p.side), p.voice.empty() ? "" : " voice " + p.voice,
                           p.role ? std::format(" role {}", *p.role) : "", p.dead ? "dead" : "alive",
                           p.position ? std::format("({:.1f}, {:.1f}, {:.1f})", p.position->x, p.position->y, p.position->z)
                                      : std::string("none"),
                           p.yaw, p.pitch));
    }
    if (!snap->local()) r.fail("no local player in the roster", "ClientLocalGameWorld.MainPlayer");

    const auto eq = world.equipment.get();
    if (eq->players.empty())
        r.fail("no equipment read for any player",
               "Player._inventoryController → InventoryController.Inventory → Inventory.Equipment → "
               "InventoryEquipment._cachedSlots; Slot.*; class CompoundItem");
    else
        r.ok(std::format("equipment for {} players (e.g. #{}: {} slots, {} items)", eq->players.size(),
                         eq->players[0].playerId, eq->players[0].slots.size(), countNodes(eq->players[0].slots)));
}

void checkExfils(Report& r, const std::shared_ptr<const eft::RaidSession>& session) {
    r.section("Exfils");
    eft::WorldState world;
    eft::Exfils exfils(session, world);
    exfils.discover();
    const auto snap = world.exfils.get();
    int regular = 0, secret = 0, positioned = 0;
    for (const auto& e : snap->exfils) {
        (e.kind == eft::Exfil::Kind::Secret ? secret : regular)++;
        positioned += e.position ? 1 : 0;
    }
    if (snap->exfils.empty())
        r.fail("no exfils", "ClientLocalGameWorld.ExfiltrationController, ExfiltrationController.*, ExitSettings.Name");
    else
        r.ok(std::format("{} regular + {} secret exfils, {} with position", regular, secret, positioned));
    if (regular == 0 && secret > 0)
        r.fail("no regular exfils: eligibility didn't match",
               "PlayerInfo.EntryPoint (PMC) / Profile.Id (scav), ExfiltrationPoint.EligibleEntryPoints / ScavExfiltrationPoint.EligibleIds");
    for (const auto& e : snap->exfils) r.info(std::format("'{}' status {}", e.name, e.status));
}

void checkExplosives(Report& r, const std::shared_ptr<const eft::RaidSession>& session) {
    r.section("Explosives");
    const auto& game = session->game;
    const Address grenades = eft::readPointer(game, session->start.localGameWorld + off::ClientLocalGameWorld::Grenades,
                                              mem::Freshness::Fresh);
    const auto grenadeList = grenades ? game.managed.readList<Address>(
                                            eft::readPointer(game, grenades + off::GrenadeCollection::List), 512)
                                      : std::nullopt;
    if (grenadeList) r.ok(std::format("grenade list readable ({} active)", grenadeList->size()));
    else r.fail("grenade list unreadable", "ClientLocalGameWorld.Grenades, literal GrenadeCollection.List");

    eft::WorldState world;
    eft::Explosives explosives(session, world);
    explosives.updateTripwires();
    const Address processor = eft::readPointer(
        game, session->start.localGameWorld + off::GameWorld::SynchronizableObjectLogicProcessor, mem::Freshness::Fresh);
    if (!processor) {
        r.fail("SynchronizableObjectLogicProcessor unreadable", "GameWorld.SynchronizableObjectLogicProcessor");
        return;
    }
    std::map<std::int32_t, int> types;
    for (auto field : {off::SynchronizableObjectLogicProcessor::_activeSynchronizableObjects,
                       off::SynchronizableObjectLogicProcessor::_staticSynchronizableObjects}) {
        const auto list = game.managed.readList<Address>(eft::readPointer(game, processor + field), 512);
        if (list)
            for (Address o : *list) ++types[game.mem.read<std::int32_t>(o + off::SynchronizableObject::Type)];
    }
    std::string hist;
    for (const auto& [type, n] : types) hist += std::format("{}type {} ×{}", hist.empty() ? "" : ", ", type, n);
    r.ok(std::format("synchronizable objects: {}; {} armed tripwire(s)", hist.empty() ? "none" : hist,
                     world.explosives.get()->tripwires.size()));
    r.info(std::format("tripwires are type {} (verify on a map with tripwires)", eft::Explosives::kTripwireType));
}

void checkLoot(Report& r, const std::shared_ptr<const eft::RaidSession>& session) {
    r.section("Loot");
    eft::WorldState world;
    eft::Loot loot(session, world);
    const auto t = Clock::now();
    loot.scan(t);
    for (int i = 1; i <= 50; ++i) loot.resolve(t + std::chrono::seconds(30 * i));  // past all back-offs
    const auto snap = world.loot.get();
    std::map<std::string, int> kinds;
    std::size_t withContents = 0, contentNodes = 0;
    for (const auto& l : snap->loot) {
        static constexpr const char* names[] = {"items", "quest items", "containers", "airdrops", "corpses"};
        ++kinds[names[static_cast<int>(l.kind)]];
        if (!l.contents.empty()) {
            ++withContents;
            contentNodes += countNodes(l.contents);
        }
    }
    std::string summary;
    for (const auto& [k, n] : kinds) summary += std::format("{}{} {}", summary.empty() ? "" : ", ", n, k);
    if (snap->loot.empty())
        r.fail("no loot resolved", "ClientLocalGameWorld.LootList; loot class names in Names.hpp; InteractiveLootItem.Item, "
                                   "Item.Template, ItemTemplate._id, literal MongoID.StringId");
    else
        r.ok(std::format("{} loot entries: {}", snap->loot.size(), summary));
    r.info(std::format("{} containers/corpses with contents ({} items){}", withContents, contentNodes,
                       off::CompoundItem::Grids ? "" : "; grid offsets unknown, so grid contents are skipped"));
    for (std::size_t i = 0; i < std::min<std::size_t>(5, snap->loot.size()); ++i) {
        const auto& l = snap->loot[i];
        r.info(std::format("tpl {} obj '{}' at ({:.1f}, {:.1f}, {:.1f})", l.templateId.empty() ? "-" : l.templateId,
                           l.objectName, l.position.x, l.position.y, l.position.z));
    }
}

}  // namespace

int runDiagnose(mem::Target& target, int timeoutSeconds, std::FILE* out) {
    Report r(out);
    r.section("Attach");
    const auto start = Clock::now();
    while (target.poll() != mem::Target::State::Attached) {
        if (Clock::now() - start > std::chrono::seconds(timeoutSeconds)) {
            r.fail(std::format("not attached after {} s (state: {})", timeoutSeconds, mem::stateName(target.state())),
                   "is the game running? process/module names in game/eft/Names.hpp");
            return 1;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(500));
    }
    r.ok(std::format("attached to {} (pid {})", target.processName(), target.pid().value_or(0)));
    for (const auto& [name, info] : target.modules()) r.info(std::format("{} at {} ({:#x} bytes)", name, hex(info.base), info.size));
    for (const auto& c : eft::checkBuild(target)) {
        using R = eft::ModuleBuildCheck::Result;
        const auto loaded = std::format("timestamp {:#x}, size {:#x}", c.loadedTimestamp, c.loadedSize);
        switch (c.result) {
        case R::Match: r.ok(c.module + " matches the offsets' build"); break;
        case R::Mismatch: r.info(c.module + " differs from the offsets' build (" + loaded + ")"); break;
        case R::NotRecorded: r.info(c.module + ": no fingerprint recorded; loaded " + loaded); break;
        case R::Unreadable: r.fail("can't read " + c.module + "'s PE header", "memory access / module base"); break;
        }
    }

    const auto game = eft::Game::fromTarget(target);
    checkIl2Cpp(r, game);
    checkUnity(r, game);
    const auto raid = checkRaid(r, game);
    if (raid) {
        auto session = std::make_shared<eft::RaidSession>(
            eft::RaidSession{.id = 1, .game = game, .start = *raid, .startedAt = Clock::now()});
        checkPlayers(r, session);
        checkExfils(r, session);
        checkExplosives(r, session);
        checkLoot(r, session);
    } else {
        r.info("skipping players, exfils, explosives and loot: they need a raid");
    }

    r.section("Summary");
    if (r.failures() == 0 && raid) r.ok("everything produced data");
    else r.info(std::format("{} failed check(s); see the 'check:' hints above and docs/verification-playbook.md", r.failures()));
    return r.failures() == 0 && raid ? 0 : 1;
}

}  // namespace radar::app
