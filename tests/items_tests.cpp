#include "FakeWorld.hpp"

#include "game/eft/items/ItemTree.hpp"
#include "game/eft/players/Players.hpp"
#include "game/eft/world/Loot.hpp"

#include <doctest/doctest.h>

using namespace radar;
using radar::test::FakeWorld;
using radar::test::kIl2Cpp;
using radar::test::kUnity;
using mem::Address;
using sched::Clock;

namespace {

struct ItemClasses {
    Address item, compound, weapon, equipment;
    explicit ItemClasses(FakeWorld& w) {
        item = w.heap.klass("Item", "EFT.InventoryLogic");
        compound = w.heap.klass("CompoundItem", "EFT.InventoryLogic", item);
        weapon = w.heap.klass("Weapon", "EFT.InventoryLogic", compound);
        equipment = w.heap.klass("InventoryEquipment", "EFT.InventoryLogic", compound);
    }
};

Address makeItem(FakeWorld& w, Address klass, std::u16string_view tpl, std::int32_t count = 1) {
    auto& h = w.heap;
    const Address item = h.object(klass, 0x200), tmpl = h.alloc(0x200);
    h.put<Address>(item + off::Item::Template, tmpl);
    h.put<Address>(tmpl + off::ItemTemplate::_id + off::MongoID::StringId, h.managedString(tpl));
    h.put<std::int32_t>(item + off::Item::StackObjectsCount, count);
    return item;
}

// Slot[] with (slot id, contained item) pairs; a 0 item is an empty slot.
Address makeSlots(FakeWorld& w, const std::vector<std::pair<std::u16string_view, Address>>& slots) {
    std::vector<Address> objects;
    for (const auto& [id, item] : slots) {
        const Address slot = w.heap.alloc(0x80);
        w.heap.put<Address>(slot + off::Slot::ID, w.heap.managedString(id));
        w.heap.put<Address>(slot + off::Slot::ContainedItem, item);
        objects.push_back(slot);
    }
    return w.heap.array(objects);
}

// Grid[], one grid per list of items (GridItemCollection.ItemsList).
Address makeGrids(FakeWorld& w, const std::vector<std::vector<Address>>& grids) {
    std::vector<Address> objects;
    for (const auto& items : grids) {
        const Address grid = w.heap.alloc(0x80), collection = w.heap.alloc(0x20);
        w.heap.put<Address>(grid + *off::Grid::ItemCollection, collection);
        w.heap.put<Address>(collection + *off::GridItemCollection::ItemsList, w.heap.list(items, 8));
        objects.push_back(grid);
    }
    return w.heap.array(objects);
}

std::shared_ptr<const eft::RaidSession> makeSession(FakeWorld& w) {
    return std::make_shared<eft::RaidSession>(eft::RaidSession{
        .id = 9,
        .game = w.attachGame(),
        .start = eft::RaidCandidate{.localGameWorld = w.world, .gameWorldObject = w.world,
                                    .localPlayer = w.localPlayer, .locationId = "bigmap", .registeredCount = 1},
        .startedAt = Clock::now(),
    });
}

// A loadout: an AK with a magazine (holding ammo) in a slot, and an empty holster.
Address makeLoadout(FakeWorld& w, const ItemClasses& c) {
    const Address ammo = makeItem(w, c.item, u"ammo545", 30);
    // Non-compound items have no Slots field: put a plausible-looking pointer there to make sure the
    // reader doesn't follow it.
    w.heap.put<Address>(ammo + off::LootItemMod::Slots, makeSlots(w, {{u"bogus", makeItem(w, c.item, u"bogus")}}));
    const Address magazine = makeItem(w, c.compound, u"mag30");
    w.heap.put<Address>(magazine + off::LootItemMod::Slots, makeSlots(w, {{u"cartridges", ammo}}));
    const Address ak = makeItem(w, c.weapon, u"ak74");
    w.heap.put<Address>(ak + off::LootItemMod::Slots, makeSlots(w, {{u"mod_magazine", magazine}}));
    return makeSlots(w, {{u"FirstPrimaryWeapon", ak}, {u"Holster", 0}});
}

void checkLoadout(const std::vector<eft::ItemNode>& slots) {
    REQUIRE(slots.size() == 1);
    CHECK(slots[0].slot == "FirstPrimaryWeapon");
    CHECK(slots[0].tpl == "ak74");
    REQUIRE(slots[0].children.size() == 1);
    const auto& mag = slots[0].children[0];
    CHECK(mag.slot == "mod_magazine");
    REQUIRE(mag.children.size() == 1);
    CHECK(mag.children[0].tpl == "ammo545");
    CHECK(mag.children[0].count == 30);
    CHECK(mag.children[0].children.empty());  // not a compound item: its "Slots" isn't followed
}

}  // namespace

TEST_CASE("ItemTreeReader follows slots of compound items only, with limits") {
    FakeWorld w;
    w.newWorld(u"bigmap", 1);
    ItemClasses c(w);
    const Address slots = makeLoadout(w, c);
    const auto game = w.attachGame();

    eft::ItemTreeReader reader(game);
    checkLoadout(reader.readSlots(slots));
    CHECK_FALSE(reader.truncated());

    eft::ItemTreeReader small(game, {.maxDepth = 8, .maxNodes = 2});
    const auto truncated = small.readSlots(slots);
    CHECK(small.truncated());
    CHECK(truncated[0].children[0].children.empty());

    eft::ItemTreeReader shallow(game, {.maxDepth = 1});
    CHECK(shallow.readSlots(slots)[0].children.empty());
}

TEST_CASE("ItemTreeReader reads grid contents, nested, after slot contents") {
    FakeWorld w;
    w.newWorld(u"bigmap", 1);
    ItemClasses c(w);
    REQUIRE(off::CompoundItem::Grids);
    REQUIRE(off::Grid::ItemCollection);
    REQUIRE(off::GridItemCollection::ItemsList);

    // A container: one slot item, and two grids, the second holding a backpack with its own grid.
    const Address backpack = makeItem(w, c.compound, u"backpack");
    w.heap.put<Address>(backpack + *off::CompoundItem::Grids, makeGrids(w, {{makeItem(w, c.item, u"bolts", 3)}}));
    const Address root = makeItem(w, c.compound, u"container");
    w.heap.put<Address>(root + off::LootItemMod::Slots, makeSlots(w, {{u"main", makeItem(w, c.item, u"key")}}));
    w.heap.put<Address>(root + *off::CompoundItem::Grids,
                        makeGrids(w, {{makeItem(w, c.item, u"roubles", 5000), makeItem(w, c.item, u"gpu")},
                                      {backpack}}));
    // Non-compound items have no Grids field: a plausible pointer there must not be followed.
    const Address plain = makeItem(w, c.item, u"plain");
    w.heap.put<Address>(plain + *off::CompoundItem::Grids, makeGrids(w, {{makeItem(w, c.item, u"bogus")}}));

    const auto game = w.attachGame();
    eft::ItemTreeReader reader(game);
    const auto contents = reader.readContents(root);
    REQUIRE(contents.size() == 4);
    CHECK(contents[0].tpl == "key");
    CHECK(contents[0].slot == "main");
    CHECK(contents[1].tpl == "roubles");
    CHECK(contents[1].count == 5000);
    CHECK(contents[1].slot.empty());
    CHECK(contents[2].tpl == "gpu");
    CHECK(contents[3].tpl == "backpack");
    REQUIRE(contents[3].children.size() == 1);
    CHECK(contents[3].children[0].tpl == "bolts");
    CHECK(contents[3].children[0].count == 3);
    CHECK(reader.readContents(plain).empty());
}

TEST_CASE("Players publishes equipment trees") {
    FakeWorld w;
    w.newWorld(u"bigmap", 0);
    ItemClasses c(w);
    const Address bot = w.newPlayer();
    w.setRosterList({w.localPlayer, bot});
    const Address controller = w.heap.alloc(0x200), inventory = w.heap.alloc(0x100);
    const Address equipment = makeItem(w, c.equipment, u"equipmentroot");
    w.heap.put<Address>(bot + off::Player::_inventoryController, controller);
    w.heap.put<Address>(controller + off::InventoryController::Inventory, inventory);
    w.heap.put<Address>(inventory + off::Inventory::Equipment, equipment);
    w.heap.put<Address>(equipment + off::InventoryEquipment::_cachedSlots, makeLoadout(w, c));

    eft::WorldState world;
    {
        eft::Players players(makeSession(w), world);
        const auto t = Clock::now();
        players.rosterTick(t);
        players.equipmentTick(t);
        const auto snap = world.equipment.get();
        REQUIRE(snap->players.size() == 1);  // the local player has no inventory in this fake
        const auto botId = world.players.get()->players.back().id;
        CHECK(snap->players[0].playerId == botId);
        checkLoadout(snap->players[0].slots);

        // Nothing changes until the refresh interval has passed.
        const auto rev = snap->revision;
        w.heap.put<Address>(equipment + off::InventoryEquipment::_cachedSlots, makeSlots(w, {}));
        players.equipmentTick(t + std::chrono::seconds(1));
        CHECK(world.equipment.get()->revision == rev);
        players.equipmentTick(t + eft::Players::kEquipmentRefresh + std::chrono::seconds(1));
        CHECK(world.equipment.get()->players.empty());  // dropped everything
    }
    CHECK(world.equipment.get()->players.empty());
}

TEST_CASE("Players reads observed players' equipment through their controller") {
    FakeWorld w;
    w.newWorld(u"bigmap", 0);
    ItemClasses c(w);
    const Address observed = w.newObservedPlayer();
    w.setRosterList({w.localPlayer, observed});
    const Address opc = mem::MemoryView(w.fake, FakeWorld::kPid).read<Address>(observed + off::ObservedPlayerView::ObservedPlayerController);
    const Address controller = w.heap.alloc(0x200), inventory = w.heap.alloc(0x100);
    const Address equipment = makeItem(w, c.equipment, u"equipmentroot");
    w.heap.put<Address>(opc + off::ObservedPlayerController::InventoryController, controller);
    w.heap.put<Address>(controller + off::InventoryController::Inventory, inventory);
    w.heap.put<Address>(inventory + off::Inventory::Equipment, equipment);
    w.heap.put<Address>(equipment + off::InventoryEquipment::_cachedSlots, makeLoadout(w, c));

    eft::WorldState world;
    eft::Players players(makeSession(w), world);
    const auto t = Clock::now();
    players.rosterTick(t);
    players.equipmentTick(t);
    const auto snap = world.equipment.get();
    REQUIRE(snap->players.size() == 1);
    checkLoadout(snap->players[0].slots);
}

TEST_CASE("Loot reads container contents and corpse equipment") {
    FakeWorld w;
    w.newWorld(u"bigmap", 1);
    ItemClasses c(w);
    auto& h = w.heap;
    const Address interactive = h.klass("InteractableObject", "EFT.Interactive");
    const Address lootItemClass = h.klass("LootItem", "EFT.Interactive", interactive);
    const Address corpseClass = h.klass("Corpse", "EFT.Interactive", lootItemClass);
    const Address containerClass = h.klass("LootableContainer", "EFT.Interactive", interactive);

    auto place = [&](Address managed, std::string_view name) {
        // Minimal GameObject with a transform at (1, 1, 1).
        const Address native = h.alloc(0x100), go = h.alloc(0x100), transform = h.alloc(0x100);
        const Address hierarchy = h.alloc(0x100), trs = h.alloc(sizeof(unity::TrsX)), parents = h.alloc(4);
        h.put<Address>(managed + kIl2Cpp.unityObjectCachedPtr, native);
        h.put<Address>(native + kUnity.componentGameObject, go);
        h.put<Address>(go + kUnity.gameObjectName, h.cString(name));
        const Address entries = h.alloc(kUnity.componentEntryStride);
        h.put<Address>(entries + kUnity.componentEntryComponent, transform);
        h.put<Address>(go + kUnity.gameObjectComponents, entries);
        h.put<Address>(transform + kUnity.transformHierarchy, hierarchy);
        h.put<Address>(hierarchy + kUnity.hierarchyLocalTransforms, trs);
        h.put<Address>(hierarchy + kUnity.hierarchyParentIndices, parents);
        h.put<std::int32_t>(parents, -1);
        h.put(trs, unity::TrsX{{1, 1, 1}, 0, {}, {1, 1, 1}, 0});
    };

    // Container: its root item is a compound item whose slots hold the contents.
    const Address container = h.object(containerClass, 0x200), owner = h.alloc(0x100);
    const Address root = makeItem(w, c.compound, u"578f8782245977354405a1e3");
    h.put<Address>(container + off::LootableContainer::ItemOwner, owner);
    h.put<Address>(owner + off::LootableContainerItemOwner::RootItem, root);
    h.put<Address>(root + off::LootItemMod::Slots, makeSlots(w, {{u"main", makeItem(w, c.item, u"roubles", 5000)}}));
    place(container, "safe");

    const Address corpse = h.object(corpseClass, 0x200);
    const Address equipment = makeItem(w, c.equipment, u"equipmentroot");
    h.put<Address>(corpse + off::InteractiveLootItem::Item, equipment);
    h.put<Address>(equipment + off::LootItemMod::Slots, makeLoadout(w, c));
    place(corpse, "corpse");

    h.put<Address>(w.world + off::ClientLocalGameWorld::LootList, h.list(std::vector<Address>{container, corpse}, 8));
    eft::WorldState world;
    eft::Loot loot(makeSession(w), world);
    const auto t = Clock::now();
    loot.scan(t);
    const auto snap = world.loot.get();
    REQUIRE(snap->loot.size() == 2);
    const auto& box = snap->loot[0].kind == eft::LootEntry::Kind::Container ? snap->loot[0] : snap->loot[1];
    const auto& body = snap->loot[0].kind == eft::LootEntry::Kind::Corpse ? snap->loot[0] : snap->loot[1];
    REQUIRE(box.contents.size() == 1);
    CHECK(box.contents[0].tpl == "roubles");
    CHECK(box.contents[0].count == 5000);
    checkLoadout(body.contents);

    // Looted: the next scans refresh contents.
    h.put<Address>(root + off::LootItemMod::Slots, makeSlots(w, {{u"main", 0}}));
    loot.scan(t + std::chrono::seconds(3));
    const auto after = world.loot.get();
    for (const auto& l : after->loot)
        if (l.kind == eft::LootEntry::Kind::Container) CHECK(l.contents.empty());
}
