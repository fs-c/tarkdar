#include "FakeWorld.hpp"

#include "game/eft/world/Exfils.hpp"
#include "game/eft/world/Explosives.hpp"
#include "game/eft/world/Loot.hpp"

#include <doctest/doctest.h>

using namespace radar;
using radar::test::FakeWorld;
using radar::test::kIl2Cpp;
using radar::test::kUnity;
using mem::Address;
using math::Vec3;
using sched::Clock;

namespace {

std::shared_ptr<const eft::RaidSession> makeSession(FakeWorld& w) {
    return std::make_shared<eft::RaidSession>(eft::RaidSession{
        .id = 5,
        .game = w.attachGame(),
        .start = eft::RaidCandidate{.localGameWorld = w.world, .gameWorldObject = w.world,
                                    .localPlayer = w.localPlayer, .locationId = "bigmap", .registeredCount = 1},
        .startedAt = Clock::now(),
    });
}

// Gives a managed component a native side, a named GameObject and a Transform at `pos`.
void place(FakeWorld& w, Address managed, Vec3 pos, std::string_view name = "object") {
    auto& h = w.heap;
    const Address native = h.alloc(0x100), go = h.alloc(0x100), transform = h.alloc(0x100);
    const Address hierarchy = h.alloc(0x100), trs = h.alloc(sizeof(unity::TrsX)), parents = h.alloc(4);
    h.put<Address>(managed + kIl2Cpp.unityObjectCachedPtr, native);
    h.put<Address>(native + kUnity.componentGameObject, go);
    h.put<Address>(go + kUnity.gameObjectName, h.cString(name));
    const Address entries = h.alloc(kUnity.componentEntryStride);
    h.put<Address>(entries + kUnity.componentEntryComponent, transform);
    h.put<Address>(go + kUnity.gameObjectComponents, entries);
    h.put<std::uint64_t>(go + kUnity.gameObjectComponentCount, 1);
    h.put<Address>(transform + kUnity.transformHierarchy, hierarchy);
    h.put<std::int32_t>(transform + kUnity.transformIndex, 0);
    h.put<Address>(hierarchy + kUnity.hierarchyLocalTransforms, trs);
    h.put<Address>(hierarchy + kUnity.hierarchyParentIndices, parents);
    h.put<std::int32_t>(parents, -1);
    h.put(trs, unity::TrsX{pos, 0, {}, {1, 1, 1}, 0});
}

void move(FakeWorld& w, Address managed, Vec3 pos) {
    mem::MemoryView view(w.fake, FakeWorld::kPid);
    const Address native = view.read<Address>(managed + kIl2Cpp.unityObjectCachedPtr);
    const Address go = view.read<Address>(native + kUnity.componentGameObject);
    const Address transform = view.read<Address>(view.read<Address>(go + kUnity.gameObjectComponents) + kUnity.componentEntryComponent);
    const Address trs = view.read<Address>(view.read<Address>(transform + kUnity.transformHierarchy) + kUnity.hierarchyLocalTransforms);
    w.heap.put(trs, unity::TrsX{pos, 0, {}, {1, 1, 1}, 0});
}

// An item template with a MongoID string id.
Address itemWithTemplate(FakeWorld& w, std::u16string_view templateId, bool quest = false) {
    auto& h = w.heap;
    const Address item = h.alloc(0x100), tmpl = h.alloc(0x200);
    h.put<Address>(item + off::Item::Template, tmpl);
    h.put<Address>(tmpl + off::ItemTemplate::_id + off::MongoID::StringId, h.managedString(templateId));
    h.put<std::uint8_t>(tmpl + off::ItemTemplate::QuestItem, quest ? 1 : 0);
    return item;
}

bool near(Vec3 a, Vec3 b) { return std::fabs(a.x - b.x) < 1e-3f && std::fabs(a.y - b.y) < 1e-3f && std::fabs(a.z - b.z) < 1e-3f; }

}  // namespace

TEST_CASE("Exfils: eligibility, secret exfils, status") {
    FakeWorld w;
    w.newWorld(u"bigmap", 1);
    auto& h = w.heap;
    // Local PMC entering at "House".
    mem::MemoryView view(w.fake, FakeWorld::kPid);
    const Address info = view.read<Address>(view.read<Address>(w.localPlayer + off::Player::Profile) + off::Profile::Info);
    h.put<Address>(info + off::PlayerInfo::EntryPoint, h.managedString(u"House "));

    const Address exfilClass = h.klass("ExfiltrationPoint", "EFT.Interactive");
    auto makeExfil = [&](std::u16string_view name, std::vector<std::u16string_view> entryPoints, std::int32_t status, Vec3 pos) {
        const Address e = h.object(exfilClass, 0x200);
        const Address settings = h.alloc(0x40);
        h.put<Address>(e + off::ExfiltrationPoint::Settings, settings);
        h.put<Address>(settings + off::ExitSettings::Name, h.managedString(name));
        std::vector<Address> eps;
        for (auto ep : entryPoints) eps.push_back(h.managedString(ep));
        h.put<Address>(e + off::ExfiltrationPoint::EligibleEntryPoints, h.array(eps));
        h.put<std::int32_t>(e + off::ExfiltrationPoint::Status, status);
        place(w, e, pos);
        return e;
    };
    const Address mine = makeExfil(u"ZB-1011", {u"Customs", u"house"}, 4, {10, 1, 20});
    makeExfil(u"Other side", {u"Boiler"}, 4, {30, 1, 40});
    const Address secret = makeExfil(u"Secret door", {}, 1, {50, 1, 60});
    const Address controller = h.alloc(0x40);
    h.put<Address>(w.world + off::ClientLocalGameWorld::ExfiltrationController, controller);
    h.put<Address>(controller + off::ExfiltrationController::ExfiltrationPoints,
                   h.array(std::vector<Address>{mine, view.read<Address>(0) /*null entry*/, makeExfil(u"Other", {u"x"}, 4, {1, 1, 1})}));
    h.put<Address>(controller + off::ExfiltrationController::MSecretExfiltrationPoints, h.array(std::vector<Address>{secret}));

    eft::WorldState world;
    {
        eft::Exfils exfils(makeSession(w), world);
        exfils.discover();
        auto snap = world.exfils.get();
        REQUIRE(snap->exfils.size() == 2);
        CHECK(snap->exfils[0].name == "ZB-1011");
        CHECK(snap->exfils[0].kind == eft::Exfil::Kind::Regular);
        CHECK(snap->exfils[0].status == 4);
        CHECK(near(*snap->exfils[0].position, {10, 1, 20}));
        CHECK(snap->exfils[1].kind == eft::Exfil::Kind::Secret);

        h.put<std::int32_t>(mine + off::ExfiltrationPoint::Status, 1);
        exfils.refreshStatus();
        CHECK(world.exfils.get()->exfils[0].status == 1);

        exfils.discover();  // merging: nothing new
        CHECK(world.exfils.get()->exfils.size() == 2);
    }
    CHECK(world.exfils.get()->exfils.empty());
}

TEST_CASE("Explosives: grenades and tripwires") {
    FakeWorld w;
    w.newWorld(u"bigmap", 1);
    auto& h = w.heap;
    const Address throwable = h.klass("Throwable", "");
    const Address g1 = h.object(throwable), g2 = h.object(throwable);
    place(w, g1, {5, 1, 5});
    place(w, g2, {6, 1, 6});
    const Address collection = h.alloc(0x40);
    h.put<Address>(w.world + off::ClientLocalGameWorld::Grenades, collection);
    h.put<Address>(collection + off::GrenadeCollection::List, h.list(std::vector<Address>{g1, g2, g1}));

    auto tripwire = [&](std::int32_t type, std::int32_t state, Vec3 from, Vec3 to) {
        const Address t = h.alloc(0x200);
        h.put<std::int32_t>(t + off::SynchronizableObject::Type, type);
        h.put<std::int32_t>(t + off::TripwireSynchronizableObject::_tripwireState, state);
        h.put(t + off::TripwireSynchronizableObject::FromPosition, from);
        h.put(t + off::TripwireSynchronizableObject::ToPosition, to);
        return t;
    };
    const Address armed = tripwire(2, 1, {1, 0, 1}, {3, 0, 1});
    const Address triggered = tripwire(2, 3, {1, 0, 2}, {3, 0, 2});
    const Address notTripwire = tripwire(1, 1, {1, 0, 3}, {3, 0, 3});
    const Address processor = h.alloc(0x40);
    h.put<Address>(w.world + off::GameWorld::SynchronizableObjectLogicProcessor, processor);
    h.put<Address>(processor + off::SynchronizableObjectLogicProcessor::_activeSynchronizableObjects,
                   h.list(std::vector<Address>{armed, triggered}));
    h.put<Address>(processor + off::SynchronizableObjectLogicProcessor::_staticSynchronizableObjects,
                   h.list(std::vector<Address>{notTripwire, armed}));

    eft::WorldState world;
    eft::Explosives explosives(makeSession(w), world);
    explosives.updateGrenades();
    explosives.updateTripwires();
    auto snap = world.explosives.get();
    REQUIRE(snap->grenades.size() == 2);
    REQUIRE(snap->tripwires.size() == 1);
    CHECK(near(snap->tripwires[0].from, {1, eft::Explosives::kTripwireYOffset, 1}));
    CHECK(near(snap->tripwires[0].to, {3, eft::Explosives::kTripwireYOffset, 1}));

    // A destroyed grenade that's still in the list isn't re-added (and doesn't republish).
    h.put<std::uint8_t>(g2 + off::Throwable::_isDestroyed, 1);
    explosives.updateGrenades();
    const auto rev = world.explosives.get()->revision;
    explosives.updateGrenades();
    CHECK(world.explosives.get()->revision == rev);
    CHECK(world.explosives.get()->grenades.size() == 1);
    h.put<std::uint8_t>(g2 + off::Throwable::_isDestroyed, 0);

    // A grenade moves, another explodes; the tripwire gets triggered.
    move(w, g1, {7, 2, 7});
    h.put<std::uint8_t>(g2 + off::Throwable::_isDestroyed, 1);
    h.put<std::int32_t>(armed + off::TripwireSynchronizableObject::_tripwireState, 4);
    explosives.updateGrenades();
    explosives.updateTripwires();
    snap = world.explosives.get();
    REQUIRE(snap->grenades.size() == 1);
    CHECK(near(snap->grenades[0].position, {7, 2, 7}));
    CHECK(snap->tripwires.empty());
}

TEST_CASE("Loot: classification, positions, removal") {
    FakeWorld w;
    w.newWorld(u"bigmap", 1);
    auto& h = w.heap;
    const Address interactive = h.klass("InteractableObject", "EFT.Interactive");
    const Address lootItemClass = h.klass("LootItem", "EFT.Interactive", interactive);
    const Address observedItemClass = h.klass("ObservedLootItem", "EFT.Interactive", lootItemClass);
    const Address corpseClass = h.klass("Corpse", "EFT.Interactive", lootItemClass);
    const Address containerClass = h.klass("LootableContainer", "EFT.Interactive", interactive);
    const Address otherClass = h.klass("Door", "EFT.Interactive", interactive);

    const Address item = h.object(lootItemClass, 0x200);
    h.put<Address>(item + off::InteractiveLootItem::Item, itemWithTemplate(w, u"5449016a4bdc2d6f028b456f"));
    place(w, item, {1, 1, 1}, "item_roubles");
    const Address quest = h.object(observedItemClass, 0x200);
    h.put<Address>(quest + off::InteractiveLootItem::Item, itemWithTemplate(w, u"questtpl", true));
    place(w, quest, {2, 1, 2}, "quest_item");
    const Address container = h.object(containerClass, 0x200);
    const Address owner = h.alloc(0x100);
    h.put<Address>(container + off::LootableContainer::ItemOwner, owner);
    h.put<Address>(owner + off::LootableContainerItemOwner::RootItem, itemWithTemplate(w, u"578f8782245977354405a1e3"));
    place(w, container, {3, 1, 3}, "container_safe");
    const Address airdrop = h.object(containerClass, 0x200);
    place(w, airdrop, {4, 50, 4}, "Loot_Collider airdrop");
    const Address corpse = h.object(corpseClass, 0x200);
    place(w, corpse, {5, 1, 5}, "corpse");
    const Address door = h.object(otherClass, 0x200);
    place(w, door, {6, 1, 6}, "door");
    const Address scripted = h.object(lootItemClass, 0x200);
    place(w, scripted, {7, 1, 7}, "Script_thing");
    const Address noPosition = h.object(lootItemClass, 0x200);
    h.put<Address>(noPosition + off::InteractiveLootItem::Item, itemWithTemplate(w, u"later"));

    auto setList = [&](std::vector<Address> l) {
        h.put<Address>(w.world + off::ClientLocalGameWorld::LootList, h.list(l, 64));
    };
    setList({item, quest, container, airdrop, corpse, door, scripted, noPosition});

    eft::WorldState world;
    eft::Loot loot(makeSession(w), world);
    auto t = Clock::now();
    loot.scan(t);
    auto snap = world.loot.get();
    REQUIRE(snap->loot.size() == 5);
    auto find = [&](eft::LootEntry::Kind kind) -> const eft::LootEntry* {
        for (const auto& l : world.loot.get()->loot)
            if (l.kind == kind) return &l;
        return nullptr;
    };
    REQUIRE(find(eft::LootEntry::Kind::Item));
    CHECK(find(eft::LootEntry::Kind::Item)->templateId == "5449016a4bdc2d6f028b456f");
    CHECK(find(eft::LootEntry::Kind::Item)->objectName == "item_roubles");
    CHECK(find(eft::LootEntry::Kind::QuestItem)->templateId == "questtpl");  // via subclass ObservedLootItem
    CHECK(find(eft::LootEntry::Kind::Container)->templateId == "578f8782245977354405a1e3");
    CHECK(near(find(eft::LootEntry::Kind::Airdrop)->position, {4, 50, 4}));
    CHECK(find(eft::LootEntry::Kind::Corpse));

    SUBCASE("an entry without a position is retried and picked up later") {
        place(w, noPosition, {8, 1, 8}, "late_item");
        loot.resolve(t + std::chrono::milliseconds(100));  // still backing off
        CHECK(world.loot.get()->loot.size() == 5);
        loot.resolve(t + std::chrono::seconds(3));
        CHECK(world.loot.get()->loot.size() == 6);
    }
    SUBCASE("airdrops are re-positioned each scan") {
        move(w, airdrop, {4, 2, 4});
        loot.scan(t + std::chrono::seconds(3));
        CHECK(near(find(eft::LootEntry::Kind::Airdrop)->position, {4, 2, 4}));
    }
    SUBCASE("an address reused by a different object is resolved again") {
        // The quest item's address now holds a corpse (same address, different class).
        h.put<Address>(quest + kIl2Cpp.objectKlass, corpseClass);
        loot.scan(t + std::chrono::seconds(3));
        int corpses = 0, quests = 0;
        for (const auto& l : world.loot.get()->loot) {
            corpses += l.kind == eft::LootEntry::Kind::Corpse;
            quests += l.kind == eft::LootEntry::Kind::QuestItem;
        }
        CHECK(corpses == 2);
        CHECK(quests == 0);
    }
    SUBCASE("entries missing from two scans are removed") {
        setList({quest, container, airdrop, corpse});
        loot.scan(t + std::chrono::seconds(3));
        CHECK(world.loot.get()->loot.size() == 5);
        loot.scan(t + std::chrono::seconds(6));
        CHECK(world.loot.get()->loot.size() == 4);
    }
}

TEST_CASE("Loot: a sudden drop to under half the cache isn't treated as removals") {
    FakeWorld w;
    w.newWorld(u"bigmap", 1);
    auto& h = w.heap;
    const Address cls = h.klass("LootItem", "EFT.Interactive");
    std::vector<Address> items;
    for (int i = 0; i < 40; ++i) {
        const Address it = h.object(cls, 0x200);
        h.put<Address>(it + off::InteractiveLootItem::Item, itemWithTemplate(w, u"tpl"));
        place(w, it, {float(i) + 1, 1, 1});
        items.push_back(it);
    }
    h.put<Address>(w.world + off::ClientLocalGameWorld::LootList, h.list(items, 64));
    eft::WorldState world;
    eft::Loot loot(makeSession(w), world);
    const auto t = Clock::now();
    loot.scan(t);
    REQUIRE(world.loot.get()->loot.size() == 40);
    h.put<Address>(w.world + off::ClientLocalGameWorld::LootList, h.list(std::vector<Address>{items[0]}, 64));
    loot.scan(t + std::chrono::seconds(3));
    loot.scan(t + std::chrono::seconds(6));
    CHECK(world.loot.get()->loot.size() == 40);
}
