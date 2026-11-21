#include "FakeObjects.hpp"
#include "FakePlayers.hpp"
#include "TestMath.hpp"

#include "game/eft/world/Exfils.hpp"
#include "game/eft/world/Explosives.hpp"
#include "game/eft/world/Loot.hpp"
#include "game/eft/world/Quests.hpp"
#include "game/eft/world/Vehicles.hpp"
#include "game/eft/players/Players.hpp"

#include <doctest/doctest.h>

using namespace radar;
using radar::test::FakeWorld;
using radar::test::itemWithTemplate;
using radar::test::move;
using radar::test::near;
using radar::test::place;
using radar::test::kIl2Cpp;
using radar::test::kUnity;
using mem::Address;
using math::Vec3;
using sched::Clock;

namespace {

struct MongoId {  // EFT's MongoID struct, stored inline
    std::uint32_t timestamp;
    std::uint64_t counter;
    Address stringId;
};

// A fake raid for the quest tests, with the managed-collection helpers and the Condition class
// hierarchy they share.
struct QuestWorld {
    FakeWorld w;
    test::Heap& h = w.heap;
    Address profile = 0;
    Address listClass = 0, condition = 0, multi = 0, item = 0, findClass = 0;

    QuestWorld() {
        w.newWorld(u"bigmap", 1);
        mem::MemoryView view(w.fake, FakeWorld::kPid);
        profile = view.read<Address>(w.localPlayer + off::Player::Profile);
        listClass = h.klass("List`1", "System.Collections.Generic");
        condition = h.klass("Condition", "EFT.Quests");
        multi = h.klass("ConditionMultipleTargets", "EFT.Quests", condition);
        item = h.klass("ConditionItem", "EFT.Quests", multi);
        findClass = h.klass("ConditionFindItem", "EFT.Quests", item);
    }

    Address managedList(const std::vector<Address>& items) {
        const Address l = h.list(items);
        h.put<Address>(l + kIl2Cpp.objectKlass, listClass);
        return l;
    }
    Address strings(std::initializer_list<std::u16string_view> ss) {
        std::vector<Address> v;
        for (auto s : ss) v.push_back(h.managedString(s));
        return h.array(v);
    }
    // Profile.TaskConditionCounters with one TaskConditionCounter, keyed by the MongoID string `id`.
    void putCounters(Address counter, Address idString) {
        struct CounterEntry {
            std::int32_t hashCode, next;
            MongoId key;
            Address value;
        };
        const Address counters = h.alloc(0x50);
        h.put<Address>(counters + kIl2Cpp.dictEntries,
                       h.array(std::vector<CounterEntry>{{1, -1, {1, 2, idString}, counter}}));
        h.put<std::int32_t>(counters + kIl2Cpp.dictCount, 1);
        h.put<Address>(profile + off::Profile::TaskConditionCounters, counters);
    }
};

}  // namespace

TEST_CASE("Exfils: eligibility, secret exfils, names, status") {
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

    // The game's texts: EFT.LocalizationManager._instance._locales, culture → EFT.Locale (keys ignore case).
    struct TextEntry {
        std::int32_t hashCode, next;
        Address key, value;
    };
    const auto textTable = [&](std::vector<TextEntry> entries) {
        const Address d = h.object(h.klass("Locale", "EFT"), 0x50);
        h.put<Address>(d + kIl2Cpp.dictEntries, h.array(entries));
        h.put<std::int32_t>(d + kIl2Cpp.dictCount, static_cast<std::int32_t>(entries.size()));
        return d;
    };
    const auto text = [&](std::u16string_view k, std::u16string_view v) { return TextEntry{1, -1, h.managedString(k), h.managedString(v)}; };
    const Address english = textTable({text(u"Gate 3", u"Gate 3"), {-1, -1, 0, 0} /*freed*/, text(u"secret DOOR", u"Smugglers' Passage")});
    const Address russian = textTable({text(u"Secret door", u"Проход контрабандистов")});
    const Address managerClass = h.klass("LocalizationManager", "EFT");
    const Address managerStatics = h.alloc(0x20), manager = h.object(managerClass, 0x80);
    h.put<Address>(managerClass + kIl2Cpp.classStaticFields, managerStatics);
    h.put<Address>(w.typeInfoTable + static_cast<Address>(off::LocalizationManager::TypeIndex) * 8, managerClass);
    h.put<Address>(managerStatics + off::LocalizationManager::Instance, manager);
    h.put<Address>(manager + off::LocalizationManager::Culture, h.managedString(u"en"));
    h.put<Address>(manager + off::LocalizationManager::Locales,
                   textTable({{1, -1, h.managedString(u"ru"), russian}, {1, -1, h.managedString(u"en"), english}}));

    eft::WorldState world;
    {
        eft::Exfils exfils(w.makeSession(5), world);
        exfils.discover();
        auto snap = world.exfils.get();
        REQUIRE(snap->exfils.size() == 2);
        CHECK(snap->exfils[0].name == "ZB-1011");  // no text: its exit name
        CHECK(snap->exfils[0].key == "ZB-1011");
        CHECK(snap->exfils[1].name == "Smugglers' Passage");  // the current culture's, ignoring case
        CHECK(snap->exfils[1].key == "Secret door");
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

TEST_CASE("Exfils: a name that couldn't be looked up yet resolves once the text table is readable") {
    FakeWorld w;
    w.newWorld(u"bigmap", 1);
    auto& h = w.heap;
    mem::MemoryView view(w.fake, FakeWorld::kPid);
    const Address info = view.read<Address>(view.read<Address>(w.localPlayer + off::Player::Profile) + off::Profile::Info);
    h.put<Address>(info + off::PlayerInfo::EntryPoint, h.managedString(u"House"));

    const Address exfil = h.object(h.klass("ExfiltrationPoint", "EFT.Interactive"), 0x200);
    const Address settings = h.alloc(0x40);
    h.put<Address>(exfil + off::ExfiltrationPoint::Settings, settings);
    h.put<Address>(settings + off::ExitSettings::Name, h.managedString(u"ZB-1011"));
    h.put<Address>(exfil + off::ExfiltrationPoint::EligibleEntryPoints, h.array(std::vector<Address>{h.managedString(u"House")}));
    place(w, exfil, {10, 1, 20});
    const Address controller = h.alloc(0x40);
    h.put<Address>(w.world + off::ClientLocalGameWorld::ExfiltrationController, controller);
    h.put<Address>(controller + off::ExfiltrationController::ExfiltrationPoints, h.array(std::vector<Address>{exfil}));

    // The text table isn't there yet: LocalizationManager has no instance.
    struct TextEntry {
        std::int32_t hashCode, next;
        Address key, value;
    };
    const auto textTable = [&](std::vector<TextEntry> entries) {
        const Address d = h.object(h.klass("Locale", "EFT"), 0x50);
        h.put<Address>(d + kIl2Cpp.dictEntries, h.array(entries));
        h.put<std::int32_t>(d + kIl2Cpp.dictCount, static_cast<std::int32_t>(entries.size()));
        return d;
    };
    const Address managerClass = h.klass("LocalizationManager", "EFT");
    const Address managerStatics = h.alloc(0x20);
    h.put<Address>(managerClass + kIl2Cpp.classStaticFields, managerStatics);
    h.put<Address>(w.typeInfoTable + static_cast<Address>(off::LocalizationManager::TypeIndex) * 8, managerClass);

    eft::WorldState world;
    eft::Exfils exfils(w.makeSession(5), world);
    exfils.discover();
    REQUIRE(world.exfils.get()->exfils.size() == 1);
    CHECK(world.exfils.get()->exfils[0].name == "ZB-1011");  // meanwhile: the exit name

    // Too soon: not looked up again yet.
    const auto now = Clock::now();
    const Address manager = h.object(managerClass, 0x80);
    h.put<Address>(managerStatics + off::LocalizationManager::Instance, manager);
    h.put<Address>(manager + off::LocalizationManager::Culture, h.managedString(u"en"));
    const Address english =
        textTable({{1, -1, h.managedString(u"zb-1011"), h.managedString(u"D-2 Exfil")}});
    h.put<Address>(manager + off::LocalizationManager::Locales,
                   textTable({{1, -1, h.managedString(u"en"), english}}));
    exfils.refreshStatus(now);
    CHECK(world.exfils.get()->exfils[0].name == "ZB-1011");

    exfils.refreshStatus(now + eft::Exfils::kNameRetryInterval + std::chrono::seconds(1));
    CHECK(world.exfils.get()->exfils[0].name == "D-2 Exfil");
    CHECK(world.exfils.get()->exfils[0].key == "ZB-1011");
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
    eft::Explosives explosives(w.makeSession(5), world);
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
    const Address objectClass = h.klass("Object", "System");
    const Address interactive = h.klass("InteractableObject", "EFT.Interactive", objectClass);
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
    eft::Loot loot(w.makeSession(5), world);
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

TEST_CASE("Loot: classes whose ancestry can't be read") {
    FakeWorld w;
    w.newWorld(u"bigmap", 1);
    auto& h = w.heap;
    const Address objectClass = h.klass("Object", "System");
    const Address interactive = h.klass("InteractableObject", "EFT.Interactive", objectClass);
    const Address lootItemClass = h.klass("LootItem", "EFT.Interactive", interactive);
    // Parent pointers that read as zero: the walk stops before LootItem (and System.Object).
    const Address observedItemClass = h.klass("ObservedLootItem", "EFT.Interactive");
    const Address observedCorpseClass = h.klass("ObservedCorpse", "EFT.Interactive");
    const Address mysteryClass = h.klass("Mystery", "EFT.Interactive");

    const Address item = h.object(observedItemClass, 0x200);
    h.put<Address>(item + off::InteractiveLootItem::Item, itemWithTemplate(w, u"5449016a4bdc2d6f028b456f"));
    place(w, item, {1, 1, 1}, "item_roubles");
    const Address corpse = h.object(observedCorpseClass, 0x200);
    place(w, corpse, {2, 1, 2}, "corpse");
    const Address mystery = h.object(mysteryClass, 0x200);
    h.put<Address>(mystery + off::InteractiveLootItem::Item, itemWithTemplate(w, u"later"));
    place(w, mystery, {3, 1, 3}, "item_later");
    h.put<Address>(w.world + off::ClientLocalGameWorld::LootList, h.list(std::vector<Address>{item, corpse, mystery}, 64));

    eft::WorldState world;
    eft::Loot loot(w.makeSession(5), world);
    const auto t = Clock::now();
    loot.scan(t);
    // The online replicas are known by name; the unknown class isn't ignored for good...
    auto snap = world.loot.get();
    REQUIRE(snap->loot.size() == 2);
    CHECK(snap->loot[0].kind == eft::LootEntry::Kind::Item);
    CHECK(snap->loot[1].kind == eft::LootEntry::Kind::Corpse);

    // ...but tried again, and taken once its ancestry reads as a LootItem.
    h.put<Address>(mysteryClass + kIl2Cpp.classParent, lootItemClass);
    loot.resolve(t + std::chrono::seconds(3));
    snap = world.loot.get();
    REQUIRE(snap->loot.size() == 3);
    CHECK(snap->loot[2].templateId == "later");
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
    eft::Loot loot(w.makeSession(5), world);
    const auto t = Clock::now();
    loot.scan(t);
    REQUIRE(world.loot.get()->loot.size() == 40);
    h.put<Address>(w.world + off::ClientLocalGameWorld::LootList, h.list(std::vector<Address>{items[0]}, 64));
    loot.scan(t + std::chrono::seconds(3));
    loot.scan(t + std::chrono::seconds(6));
    CHECK(world.loot.get()->loot.size() == 40);
}

TEST_CASE("Vehicles: BTR position, heading, gunner and passengers") {
    FakeWorld w;
    w.newWorld(u"TarkovStreets", 0);
    auto& h = w.heap;
    const Address gunner = newObservedPlayer(w, 4, true, u"Scav_3", Vec3{10, 4, 20});
    const Address passenger = newObservedPlayer(w, 1, false, u"Usec_5", Vec3{11, 3, 21});
    const Address approaching = newObservedPlayer(w, 2, false, u"Bear_1", Vec3{14, 1, 20});
    w.setRosterList({w.localPlayer, gunner, passenger, approaching});

    const auto session = w.makeSession(5);
    eft::WorldState world;
    eft::Players players(session, world);
    for (int i = 0; i < 4; ++i) players.rosterTick(Clock::now() + std::chrono::milliseconds(20 * i));
    REQUIRE(world.players.get()->players.size() == 4);
    eft::Vehicles vehicles(session, world, players);

    // No BtrController (a map without a BTR), then one without a view (not spawned): nothing.
    vehicles.update();
    CHECK(world.vehicles.get()->vehicles.empty());
    const Address controller = h.alloc(0x100);
    h.put<Address>(w.world + off::ClientLocalGameWorld::btrController, controller);
    vehicles.update();
    CHECK(world.vehicles.get()->vehicles.empty());

    // Spawned, heading +x (90°), driving; gunner on the turret, one passenger inside, one approaching.
    const Address view = h.object(h.klass("BTRView", "EFT.Vehicle"), 0x200);
    const float s = std::sqrt(0.5f);
    place(w, view, {10, 2, 20}, "BTR", math::Quat{0, s, 0, s});
    h.put<std::uint8_t>(view + off::BTRView::btrState, 2);
    const Address turret = h.alloc(0x100);
    h.put<Address>(view + off::BTRView::turret, turret);
    h.put<Address>(turret + off::BTRTurretView::attachedBot, gunner);
    h.put<std::uint8_t>(turret + off::BTRTurretView::attachedBot + 8, 1);
    h.put<std::int32_t>(passenger + off::ObservedPlayerView::BtrState, 3);
    h.put<std::int32_t>(approaching + off::ObservedPlayerView::BtrState, 1);
    h.put<Address>(controller + off::BtrController::BtrView, view);
    vehicles.update();
    auto snap = world.vehicles.get();
    REQUIRE(snap->vehicles.size() == 1);
    const auto& btr = snap->vehicles[0];
    CHECK(btr.kind == eft::Vehicle::Kind::Btr);
    CHECK(btr.state == 2);
    CHECK(near(btr.position, {10, 2, 20}));
    CHECK(btr.yaw == doctest::Approx(90.0f).epsilon(0.001));
    const auto idOf = [&](Address instance) {
        for (const auto& r : *players.refs())
            if (r.instance == instance) return r.id;
        return 0u;
    };
    using Seat = eft::VehicleOccupant::Seat;
    CHECK(btr.occupants == std::vector<eft::VehicleOccupant>{{idOf(gunner), Seat::Gunner}, {idOf(passenger), Seat::Passenger}});

    // Tiny moves don't republish; the local player getting in (full Player) does.
    const auto rev = snap->revision;
    move(w, view, {10.05f, 2, 20});
    vehicles.update();
    CHECK(world.vehicles.get()->revision == rev);
    h.put<std::int32_t>(w.localPlayer + off::Player::_btrState, 2);  // GoIn
    vehicles.update();
    snap = world.vehicles.get();
    CHECK(snap->revision > rev);
    REQUIRE(snap->vehicles[0].occupants.size() == 3);
    CHECK(snap->vehicles[0].occupants[0] == eft::VehicleOccupant{idOf(w.localPlayer), Seat::Passenger});

    // Despawned.
    h.put<Address>(controller + off::BtrController::BtrView, 0);
    vehicles.update();
    CHECK(world.vehicles.get()->vehicles.empty());
}

TEST_CASE("Quests: in-progress quests with their completed conditions") {
    FakeWorld w;
    w.newWorld(u"bigmap", 1);
    auto& h = w.heap;
    mem::MemoryView view(w.fake, FakeWorld::kPid);
    const Address profile = view.read<Address>(w.localPlayer + off::Player::Profile);

    struct MongoSlot {  // HashSet<MongoID> slot: {hashCode, next, MongoID{timestamp, counter, stringId}}
        std::int32_t hashCode, next;
        std::uint32_t timestamp;
        std::uint64_t counter;
        Address stringId;
    };
    static_assert(offsetof(MongoSlot, stringId) - offsetof(MongoSlot, timestamp) == off::MongoID::StringId);
    struct StringSlot {
        std::int32_t hashCode, next;
        Address value;
    };
    const auto hashSet = [&](Address slots, std::int32_t used) {
        const Address set = h.alloc(0x50);
        h.put<Address>(set + kIl2Cpp.hashSetSlots, slots);
        h.put<std::int32_t>(set + kIl2Cpp.hashSetLastIndex, used);
        return set;
    };
    const auto quest = [&](std::u16string_view id, std::int32_t status, Address completed) {
        const Address q = h.alloc(0x40);
        h.put<Address>(q + off::QuestsData::Id, h.managedString(id));
        h.put<std::int32_t>(q + off::QuestsData::Status, status);
        h.put<Address>(q + off::QuestsData::CompletedConditions, completed);
        return q;
    };
    // Started, conditions as MongoIDs (one slot freed); ready to hand in, conditions as strings;
    // finished long ago (not reported); started, with an unreadable condition set.
    const Address mongoSet = hashSet(h.array(std::vector<MongoSlot>{{5, -1, 1, 2, h.managedString(u"cond_b")},
                                                                    {-1, -1, 0, 0, 0},
                                                                    {7, -1, 3, 4, h.managedString(u"cond_a")}}),
                                     3);
    const Address started = quest(u"quest_started", eft::kQuestStarted, mongoSet);
    const Address ready = quest(u"quest_ready", eft::kQuestAvailableForFinish,
                                hashSet(h.array(std::vector<StringSlot>{{1, -1, h.managedString(u"cond_x")}}), 1));
    const Address done = quest(u"quest_done", 4, 0);
    const Address broken = quest(u"quest_broken", eft::kQuestStarted, hashSet(h.alloc(0x40), 9));
    h.put<Address>(profile + off::Profile::QuestsData, h.list(std::vector<Address>{started, ready, done, broken}));

    eft::WorldState world;
    {
        eft::Quests quests(w.makeSession(5), world);
        CHECK_FALSE(world.quests.get()->known);
        quests.update();
        auto snap = world.quests.get();
        REQUIRE(snap->known);
        CHECK(snap->raidId == 5);
        REQUIRE(snap->quests.size() == 3);  // ordered by id
        CHECK(snap->quests[0].id == "quest_broken");
        CHECK(snap->quests[0].completedConditions == std::nullopt);
        CHECK(snap->quests[1].id == "quest_ready");
        CHECK(snap->quests[1].status == eft::kQuestAvailableForFinish);
        CHECK(snap->quests[1].completedConditions == std::vector<std::string>{"cond_x"});
        CHECK(snap->quests[2].id == "quest_started");
        CHECK(snap->quests[2].status == eft::kQuestStarted);
        CHECK(snap->quests[2].completedConditions == std::vector<std::string>{"cond_a", "cond_b"});

        // Unchanged: not republished. A newly completed condition is.
        quests.update();
        CHECK(world.quests.get() == snap);
        h.put<std::int32_t>(mongoSet + kIl2Cpp.hashSetLastIndex, 2);  // cond_a gone
        quests.update();
        CHECK(world.quests.get()->revision == snap->revision + 1);
        CHECK(world.quests.get()->quests[2].completedConditions == std::vector<std::string>{"cond_b"});

        // An unreadable quest list keeps the last good one.
        h.put<Address>(profile + off::Profile::QuestsData, 0);
        quests.update();
        CHECK(world.quests.get()->quests.size() == 3);
    }
    CHECK_FALSE(world.quests.get()->known);  // cleared when the raid ends
}

TEST_CASE("Loot: battle-pass info documents are ordinary items despite the quest flag") {
    FakeWorld w;
    w.newWorld(u"bigmap", 1);
    auto& h = w.heap;
    const Address lootItemClass = h.klass("LootItem", "EFT.Interactive", h.klass("InteractableObject", "EFT.Interactive"));
    const Address doc = h.object(lootItemClass, 0x200);
    h.put<Address>(doc + off::InteractiveLootItem::Item, itemWithTemplate(w, u"infodoctpl", true));
    place(w, doc, {1, 1, 1}, "Item_barter_info_streets(Clone)");
    const Address quest = h.object(lootItemClass, 0x200);
    h.put<Address>(quest + off::InteractiveLootItem::Item, itemWithTemplate(w, u"questtpl", true));
    place(w, quest, {2, 1, 2}, "item_quest_flash_drive");
    h.put<Address>(w.world + off::ClientLocalGameWorld::LootList, h.list(std::vector<Address>{doc, quest}, 64));

    eft::WorldState world;
    eft::Loot loot(w.makeSession(5), world);
    loot.scan(Clock::now());
    const auto snap = world.loot.get();
    REQUIRE(snap->loot.size() == 2);
    for (const auto& l : snap->loot)
        CHECK(l.kind == (l.templateId == "questtpl" ? eft::LootEntry::Kind::QuestItem : eft::LootEntry::Kind::Item));
}

TEST_CASE("Quests: templates give objectives, names, kinds and hand-over progress") {
    QuestWorld qw;
    auto& w = qw.w;
    auto& h = qw.h;
    const Address profile = qw.profile;
    const auto managedList = [&](const std::vector<Address>& items) { return qw.managedList(items); };
    const auto strings = [&](std::initializer_list<std::u16string_view> ss) { return qw.strings(ss); };
    struct RefEntry {
        std::int32_t hashCode, next;
        Address key, value;
    };
    const auto stringDict = [&](std::vector<std::pair<std::u16string_view, Address>> kv) {
        std::vector<RefEntry> entries;
        for (auto& [k, v] : kv) entries.push_back({1, -1, h.managedString(k), v});
        const Address d = h.alloc(0x50);
        h.put<Address>(d + kIl2Cpp.dictEntries, h.array(entries));
        h.put<std::int32_t>(d + kIl2Cpp.dictCount, static_cast<std::int32_t>(entries.size()));
        return d;
    };

    const Address findClass = qw.findClass;
    const Address handoverClass = h.klass("ConditionHandoverItem", "EFT.Quests", qw.item);
    const Address zone = h.klass("ConditionZone", "EFT.Quests", qw.multi);
    const Address plantClass = h.klass("ConditionLeaveItemAtLocation", "EFT.Quests", zone);
    const Address killClass = h.klass("ConditionCounterCreator", "EFT.Quests", qw.condition);
    const auto cond = [&](Address klass, std::u16string_view id, float count, std::initializer_list<std::u16string_view> targets,
                          bool fir = false) {
        const Address c = h.object(klass, 0x100);
        h.put(c + off::QuestCondition::Id, MongoId{1, 2, h.managedString(id)});
        h.put<float>(c + off::QuestCondition::Value, count);
        h.put<Address>(c + off::ConditionMultipleTargets::Target, strings(targets));
        h.put<bool>(c + off::ConditionItem::OnlyFoundInRaid, fir);
        return c;
    };
    struct StatusEntry {
        std::int32_t hashCode, next, key;
        Address value;
    };
    const auto conditionsDict = [&](std::vector<Address> finish, std::vector<Address> fail = {}) {
        const auto collection = [&](const std::vector<Address>& cs) {
            const Address c = h.object(h.klass("ConditionCollection", "EFT.Quests"), 0x80);
            h.put<Address>(c + off::BindableList::List, managedList(cs));
            return c;
        };
        const Address d = h.alloc(0x50);
        h.put<Address>(d + kIl2Cpp.dictEntries, h.array(std::vector<StatusEntry>{
                                                    {5, -1, 5, collection(fail)}, {3, -1, eft::kQuestAvailableForFinish, collection(finish)}}));
        h.put<std::int32_t>(d + kIl2Cpp.dictCount, 2);
        return d;
    };
    const Address templateClass = h.klass("QuestTemplate", "EFT.Quests");
    const Address repeatableClass = h.klass("RepeatableQuestTemplate", "EFT.Quests", templateClass);
    const auto quest = [&](std::u16string_view id, Address klass, Address conditions, std::u16string_view trader) {
        const Address t = h.object(klass, 0x140);
        h.put<Address>(t + off::QuestTemplate::TraderId, h.managedString(trader));
        h.put<Address>(t + off::QuestTemplate::Conditions, conditions);
        const Address q = h.alloc(0x48);
        h.put<Address>(q + off::QuestsData::Id, h.managedString(id));
        h.put<std::int32_t>(q + off::QuestsData::Status, eft::kQuestStarted);
        h.put<Address>(q + off::QuestsData::Template, t);
        return std::pair{q, t};
    };

    // A side quest with English text: find 3 FIR (any of two items), hand them over (1 done), a kill
    // objective (not an item objective), a plant objective, and a fail condition that's left out.
    const Address find = cond(findClass, u"c_find", 3, {u"tpl_a", u"tpl_b"}, true);
    const Address handover = cond(handoverClass, u"c_hand", 3, {u"tpl_a", u"tpl_b"}, true);
    const Address plant = cond(plantClass, u"c_plant", 1, {u"tpl_c"});
    const Address kill = h.object(killClass, 0x100);
    auto [side, sideTemplate] = quest(u"q_side", templateClass,
                                      conditionsDict({find, handover, kill, plant}, {cond(findClass, u"c_fail", 1, {u"tpl_x"})}),
                                      u"trader_1");
    h.put<Address>(sideTemplate + off::QuestTemplate::Localization,
                   stringDict({{u"ru", stringDict({{u"q_side name", h.managedString(u"Russian")}})},
                               {u"en", stringDict({{u"q_side name", h.managedString(u"Shaking Up the Teller")},
                                                   {u"c_find", h.managedString(u"Find the item in raid")},
                                                   {u"q_side description", h.managedString(u"")}})}}));
    // Story: by the story trader, hidden. Daily and weekly: repeatables by how long they run.
    auto [story, storyTemplate] = quest(u"q_story", templateClass, conditionsDict({}), u"67f7af56c117b6140af2a607");
    h.put<bool>(storyTemplate + off::QuestTemplate::IsInvisible, true);
    auto [daily, dailyTemplate] = quest(u"q_daily", repeatableClass, conditionsDict({}), u"trader_2");
    h.put<std::int32_t>(daily + off::QuestsData::StartTime, 1000);
    h.put<std::int32_t>(dailyTemplate + off::RepeatableQuestTemplate::ExpirationTime, 1000 + 24 * 3600);
    auto [weekly, weeklyTemplate] = quest(u"q_weekly", repeatableClass, conditionsDict({}), u"trader_2");
    h.put<std::int32_t>(weekly + off::QuestsData::StartTime, 1000);
    h.put<std::int32_t>(weeklyTemplate + off::RepeatableQuestTemplate::ExpirationTime, 1000 + 7 * 24 * 3600);
    const Address broken = quest(u"q_broken", templateClass, 0, u"trader_1").first;  // no conditions: unreadable
    h.put<Address>(profile + off::Profile::QuestsData, h.list(std::vector<Address>{side, story, daily, weekly, broken}));

    // Condition counters: Dictionary<MongoID, TaskConditionCounter>, keyed by condition id.
    const Address counter = h.object(h.klass("TaskConditionCounter", "EFT.Quests"), 0x50);
    h.put<std::int32_t>(counter + off::TaskConditionCounter::Value, 1);
    qw.putCounters(counter, h.managedString(u"c_hand"));

    eft::WorldState world;
    eft::Quests quests(w.makeSession(5), world);
    quests.update();
    const auto snap = world.quests.get();
    REQUIRE(snap->quests.size() == 5);
    const auto byId = [&](std::string_view id) -> const eft::QuestState& {
        return *std::find_if(snap->quests.begin(), snap->quests.end(), [&](const auto& q) { return q.id == id; });
    };
    using T = eft::QuestObjective::Type;
    const auto& s = byId("q_side");
    CHECK(s.name == "Shaking Up the Teller");
    CHECK(s.traderId == "trader_1");
    CHECK(s.kind == eft::QuestKind::Side);
    CHECK_FALSE(s.hidden);
    REQUIRE(s.objectives);
    REQUIRE(s.objectives->size() == 3);
    CHECK((*s.objectives)[0] == eft::QuestObjective{.id = "c_find", .type = T::Find, .items = {"tpl_a", "tpl_b"}, .count = 3,
                                                    .foundInRaid = true, .progress = std::nullopt, .text = "Find the item in raid"});
    CHECK((*s.objectives)[1] == eft::QuestObjective{.id = "c_hand", .type = T::Handover, .items = {"tpl_a", "tpl_b"}, .count = 3,
                                                    .foundInRaid = true, .progress = 1});
    CHECK((*s.objectives)[2] == eft::QuestObjective{.id = "c_plant", .type = T::Plant, .items = {"tpl_c"}, .count = 1});
    CHECK(byId("q_story").kind == eft::QuestKind::Story);
    CHECK(byId("q_story").hidden);
    CHECK(byId("q_story").name.empty());
    CHECK(byId("q_daily").kind == eft::QuestKind::Daily);
    CHECK(byId("q_weekly").kind == eft::QuestKind::Weekly);
    CHECK_FALSE(byId("q_broken").objectives);

    // Progress is re-read; templates aren't.
    h.put<std::int32_t>(counter + off::TaskConditionCounter::Value, 2);
    h.put<Address>(sideTemplate + off::QuestTemplate::TraderId, h.managedString(u"changed"));
    quests.update();
    const auto& again = *std::find_if(world.quests.get()->quests.begin(), world.quests.get()->quests.end(),
                                      [](const auto& q) { return q.id == "q_side"; });
    CHECK((*again.objectives)[1].progress == 2);
    CHECK(again.traderId == "trader_1");
}
