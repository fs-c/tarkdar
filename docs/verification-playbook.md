# Verification playbook

Steps to run on the real setup (SPT in the QEMU VM). Everything so far was built against a fake
backend, using offsets and behaviour from a live-EFT reference implementation. This document says
what to check, why, and what to do if the result differs. Add to it whenever something is built on
an unverified assumption.

Each item has:
- **Check:** what to run or observe.
- **Expect:** the result if our assumptions hold.
- **If not:** where to look and what to change.

Sections are in dependency order: don't debug players before the raid is found.

---

## 0. Setup

### 0.1 Build and runtime files
- **Do:** `scripts/setup.sh`, then build. The script checks dependencies, initialises the submodules
  and downloads `info.db` and `libpdbcrust.so` from the MemProcFS Linux release into `build/bin/`.
- **Why:** VMM uses them for Windows symbol and PDB parsing. Without them, process and module
  enumeration can fail or be unreliable on recent Windows builds.

### 0.2 Guest RAM backing
- **Check:** the VM's memory backend is a memfd (`memory-backend-memfd`) or hugetlbfs. The patched
  QEMU plugin finds the RAM file in `/proc/<qemu pid>/fd`; if several match, it takes the largest.
- **If not:** with plain anonymous RAM there is no file to map. Switch the libvirt/QEMU config to a
  memfd backend.

### 0.3 Privileges
- **Check:** whether `radar-backend` works as the QEMU process's user (libvirt usually runs QEMU as a
  dedicated user), or only as root.
- **Note:** the eventual HTTP server shouldn't run as root. The open decision is in
  `docs/design.md`; the result of this check decides it.

---

## 1. Connectivity (M0)

**Start every session with `radar-backend --device … --diagnose`** (in a raid). It runs the whole
chain once and names the offsets to check for every failure, so it's the quickest way to see which
of the sections below need attention. Save its output.

### 1.1 Attach
- **Check:** `radar-backend --device "qemu://hugepage-pid=<qemu pid>" --once --vmm-printf --vmm-arg -v`
  with the game running.
- **Expect:** "attached to EscapeFromTarkov.exe", plus bases for `GameAssembly.dll` and
  `UnityPlayer.dll`.
- **If not:**
  - VMM init fails: see 0.1, 0.2 and 0.3. `--vmm-printf` shows VMM's reason.
  - Process not found: check the process name (`game/eft/Names.hpp`). We assume SPT launches the
    stock client executable name; confirm in the guest's task manager.
  - Modules never appear: check the module names in `Names.hpp`. An IL2CPP build must have
    `GameAssembly.dll`.

### 1.2 Record the build fingerprint
- **Check:** the attach log prints "no build fingerprint recorded for …" with the loaded timestamp
  and size of each module.
- **Do:** once the offsets are verified (section 2), copy those values into the `build` section of
  `game/eft/offsets/eft.offsets.json`. From then on a game update logs a mismatch warning.

### 1.3 Take a memory dump early
- **Do:** with the game in a raid, run `virsh suspend <vm>`, then
  `build/bin/mem-dump --device … --out <name>.raw`, then `virsh resume <vm>`. The dump is a sparse
  raw file (file offset = physical address), about the size of the guest's RAM.
- **Check:** `radar-backend --device <name>.raw --diagnose` gives the same report as live. If VMM
  can't open the raw file, try QEMU's `dump-guest-memory` (ELF) instead, and note which works.
- **Why:** a dump makes everything below repeatable offline, including later debugging sessions.
  Take one per interesting state: main menu, raid start, mid-raid with bots nearby, post-raid
  screen. Note down what's in each (map, where you stood, what was nearby).

---

## 2. Offsets: generate the SPT values

All offsets in `eft.offsets.json` are from a live EFT build and almost certainly differ for SPT.

- **Do:** in a raid, run `il2cpp-dump --device … --out spt-dump.json`, then
  `tools/update-offsets.py spt-dump.json --dry-run`, then again without `--dry-run`, and rebuild.
  Details are in `docs/offset-tools.md`.
  - **Keep the dump.** It's the reference for every "find X in the dump" item below.
  - **If the type-info table isn't found:** note which signatures matched (the dump's `notes`) and try
    `--type-info-rva`.
  - **Unity globals only validate in a raid.**
  - **Literals must be checked by hand**, using the dump: `PlayerBody.SkeletonRootJoint`,
    `Skeleton.Values`, `GrenadeCollection.List`, `MongoID.StringId`.
- **Check, per section of the JSON:**
  - `bootstrap.typeInfoTableRva`: the GameAssembly global pointing at the type-info table
    (`s_TypeInfoDefinitionTable`).
  - `unityRvas.gameObjectManager`: the UnityPlayer global holding the GameObjectManager pointer.
  - `unityLayout`: Unity engine struct offsets. These change with the **Unity version**, so check
    which Unity version the SPT client uses. If it matches the live build's, these are likely fine.
  - `managedLayout`: IL2CPP runtime layouts (Il2CppClass name/namespace/parent/static_fields at
    0x10/0x18/0x58/0xB8, string/array/list/dictionary layouts). These are stable across IL2CPP
    versions but worth a glance.
  - `types` / `fields`: class and field names come from the live client. Check each against the
    SPT dump: names may differ (obfuscated `GClassXXXX` names, renamed backing fields), and live-only
    classes may not exist offline (`ObservedPlayerView` and friends matter if SPT bots are observed
    players; see 4.1).
- **Note:** classes are added to the type-info table lazily. Some slots stay null until the class is
  used (e.g. raid-only classes in the main menu). Dump from inside a raid.

---

## 3. Raid discovery (M2)

Run `radar-backend --device …` (no `--once`) with `--verbose` and enter a raid.

### 3.1 Raid found
- **Expect:** "status: waiting for raid", then "raid #1 started: location <id>, …" within a few
  seconds of the raid starting.
- **Check which strategy found it:**
  - Strategy 1, the GamePlayerOwner static: found immediately.
  - Strategy 2, the scene scan: found 6 s or more after attach/search start, and the log's
    GameWorld value differs from the local player's world pointer.
- **If never found:**
  1. Is the location id accepted? With `--verbose`, rejected worlds are logged with their reason.
     "unknown location 'xyz'" means the id is missing from `kRaidLocations` in `game/eft/Maps.hpp`.
     SPT can have custom or modded locations: add them there.
  2. Strategy 1 needs `bootstrap.typeInfoTableRva`, `GamePlayerOwner.TypeIndex`,
     `GamePlayerOwner.MyPlayer`, `Player.GameWorld` and `managedLayout.Il2CppClass.StaticFields`.
     The type index is the most likely to differ.
  3. Strategy 2 needs `unityRvas.gameObjectManager`, the `unityLayout` GameObjectManager, GameObject
     and component offsets, and the class name `EFT.GameWorld`. It finds the component by class,
     including base classes, so a GameWorld subclass in SPT is fine.
  4. Both strategies then need `GameWorld.Location` (or `Player.Location`),
     `ClientLocalGameWorld.MainPlayer` and `ClientLocalGameWorld.RegisteredPlayers`.

### 3.2 Context: the dropped "strategy B"
The reference implementation had a third strategy between our two. It read a class pointer from a
**hard-coded GameAssembly RVA** (`0x5D71168` in the reference build). That class's static field
block, at offset `+0x10`, held the current GameWorld instance. It was probably a
`Singleton<GameWorld>`-style holder; the reference never named it. We dropped it because the RVA is
specific to one live build, and it wasn't in the offset catalogue.
- **If both remaining strategies prove unreliable** (e.g. `_myPlayer` is stale or null in SPT and
  the scene scan is too slow): find that holder class in the SPT dump (look for a generic singleton
  over `EFT.GameWorld`, or any class whose static field has type `GameWorld`/`ClientLocalGameWorld`)
  and reintroduce the strategy by name. Add a `types` entry (type index) and a static `fields` entry to
  the JSON, and read it the same way as `GamePlayerOwner` (`RaidFinder::viaGamePlayerOwner` shows
  the pattern).
- In the reference, strategy B ran before the scene scan and only when strategy 1 failed. Its result
  went through the same validation.

### 3.3 Hideout and menus never count as a raid
- **Check:** visit the hideout (SPT allows it without a raid) and the main menu.
- **Expect:** stays "waiting for raid"; with `--verbose`, "lobby location 'hideout'" rejections.
- **If not:** the hideout's LocationId may be different or empty. Extend `kLobbyLocations` in
  `Maps.hpp`.

### 3.4 Pending raids
- **Context:** a world on a raid location without a local player or registered players is
  "pending" (the raid is loading). It's retried for 6 polls (about 15 s), then dropped and possibly
  found again.
- **Check:** during raid loading the log shows "(raid found, waiting for it to start)", and the raid
  starts when you spawn.
- **If the raid starts too early** (during loading, with an incomplete roster): readiness only needs
  a local player and a non-empty roster. The reference had an additional "local player holds
  something" signal (hands controller not `EmptyHandsController`), used only for group inference.
  That could become a stricter readiness check.

### 3.5 Raid end
- **Check:** end a raid in three ways: extract, die, quit to menu. Then start a second raid without
  restarting the game.
- **Expect:** "raid #1 ended: roster empty" or "… roster unreadable" within about 10 s, then
  cooldown, waiting, and "raid #2 started" with a **different** GameWorld address.
- **Things to note:**
  - Which reason ends the raid? Does SPT empty the roster, or destroy the world? Both are handled,
    but the empty-roster path takes 12 × 0.8 s and the unreadable path 10 × 0.8 s. If ending is
    slow, these thresholds (`RaidMonitor`) can be lowered: QEMU reads are cheap.
  - **Does `GamePlayerOwner._myPlayer` still point at the old player after the raid?** If so, the
    ended-world guard (`RaidFinder::markEnded`) is what stops an immediate false "raid #2" on the
    post-raid screen. If a false restart happens, check that the guard sees the same world address.
  - **Does the next raid reuse the old GameWorld address?** That's allowed once the old world has
    been seen torn down. If raid #2 is never found, suspect the guard.
  - Quitting the game mid-raid should log "raid ended: game process lost" immediately.
  - **"the local player is in a different GameWorld"** means `_myPlayer` moved on while the old
    world's roster still looked alive. That's expected if SPT doesn't clear finished worlds.
  - **"accepting it again (the raid end was probably false)"** (a warning) means the ended-world guard
    lifted after 30 s of the old world looking ready. If that happens on the post-raid screen, the
    guard grace (`RaidFinder::kEndedWorldGrace`) needs rethinking. If it happens mid-raid, a raid end
    was falsely detected: note which reason ended it.

---

## 4. Players (M3)

Run with `--verbose` in a raid. Every 5 s the log shows a player summary, the local player's position
and look direction, and (verbose) every other player.

### 4.1 Players are built
- **Expect:** the alive count matches the bots around (roughly), with "players: +#N …" lines as bots
  spawn.
- **First:** run `--diagnose` in a raid with bots around. The Players section lists the registered
  classes, how many built per kind (`local`, `client`, `observed`), and for each entry that didn't
  build its class and the step that failed. The log says the same after 5 failures ("failed to build
  5 times, backing off: <reason>").
- **Context: two layouts.** Entries are either full `EFT.Player` objects (class
  `ClientPlayer`/`LocalPlayer`: bots simulated in this client) or `ObservedPlayerView` replicas (bots
  and players simulated elsewhere, e.g. by the server). Which one SPT uses depends on its version: if
  bots are server-side (co-op style), expect `observed`. The classification matches the reference;
  the only extension is that any `EFT.Player` subclass counts as client.
- **If only the local player is registered** while bots are clearly around: the roster list isn't the
  one the game fills. Check `ClientLocalGameWorld.RegisteredPlayers` in the dump (and whether the game
  world class has another player list or dictionary).
- **If client players fail:** a build needs `Player.Profile` → `Profile.Info` → `PlayerInfo.Side`,
  `Player._playerBody` and `Player.MovementContext`. Check those offsets.
- **If observed players fail:** a build needs `ObservedPlayerView.ObservedPlayerController` →
  `ObservedPlayerController.HealthController` / `.MovementController` →
  `ObservedMovementController.ObservedPlayerStateContext`, plus `ObservedPlayerView.IsAI` and `.Side`.
  The failure reason names the first null pointer. Rotation is `ObservedPlayerStateContext.Rotation`,
  death is `ObservedHealthController.PlayerCorpse`, the skeleton starts at `ObservedPlayerView.PlayerBody`,
  equipment at `ObservedPlayerController.InventoryController`.
- **Not ported:** the reference's BTR handling (the BTR's turret operator is a separate kind with a
  position from `BTRView`); add it if the BTR matters.

### 4.2 Positions
- **Expect:** the local position changes as you walk; bots' positions are plausible (the same order of
  magnitude as yours, y near ground level).
- **Context:** there's no position field. Position comes from skeleton bones: Base (Unity bone 0) if
  usable, else the midpoint of the feet (bones 18/23), else one foot. The bone list is reached via
  `Player._playerBody` → `+0x40` → `+0x30` → `List<Transform>`. Those two offsets are **unnamed** in
  the reference: they're the JSON literals `PlayerBody.SkeletonRootJoint` and `Skeleton.Values`, with
  guessed names. Find their real field names in the dump and record them.
- **If no player gets a position:** most likely those two literals, or the Unity transform layouts
  (`unityLayout.Transform.*`, `TransformHierarchy.*`).
- **If positions are wrong but consistent** (e.g. axes swapped, offset): suspect the TrsX layout or the
  quaternion order in `core/unity/Transforms` (Unity stores x, y, z, w).
- **If positions flicker or freeze:** implausible skeletons (a foot more than 5 m from Base, or anything
  within 2 m of the world origin) drop the bone pointers and resolve them again after up to 1 s. Many
  "resolve" cycles in a row mean the plausibility rule or the bone indices don't fit.
- **The local player:** the reference had fallbacks for when the local skeleton can't be resolved:
  `Player.PlayerBones` → `WeaponRootThird` or `Ribcage.Original` transforms,
  `Player._playerLookRaycastTransform`, and finally the camera position with the last good height.
  We have none of them yet. If the local player has no position (e.g. in first person the body isn't
  updated), add them.

### 4.3 Look direction
- **Check:** turn on the spot, look up and down; compare the logged `yaw`/`pitch`.
- **Expect:** yaw in degrees around the vertical axis, pitch up/down, read from
  `MovementContext._rotation` (x = yaw, y = pitch).
- **Record for the frontend:** which yaw corresponds to north (world +z) and whether it increases
  clockwise. The reference subtracted 90° before drawing, which suggests 0° = north (+z) and 90° = east
  (+x), Unity's convention, but that's unverified. Note the range too (0..360 or -180..180).

### 4.4 Death and leaving
- **Check:** kill a bot; watch one extract or despawn if possible.
- **Expect:** "#N died" (verbose) within about 100 ms of the death, and the dead count goes up. Players
  that leave the list without dying become "absent" after at least 3 roster ticks and 2 s.
- **Context:** death is `Player.Corpse` becoming non-null. Dead players stay in the list until the game
  removes them, and keep their last position.

### 4.5 Identity: what's missing
The reference reads no identity for full `EFT.Player` objects, so every client bot is just "AI" with a
side (USEC/BEAR/Savage). Observed players carry their voice preset (shown in the details panel); the
reference mapped voice substrings to roles (`BossKilla` → Killa, `SectantWarrior` → cultist, …),
which we don't do yet. For SPT these are wanted:
- **Nickname:** `Profile.Info.Nickname`.
- **Role:** done for full players. `Profile.Info.Settings.Role` (`WildSpawnType`) is read and sent
  as a number. The frontend (`web/src/roles.ts`) maps it with SPT's `WildSpawnTypeNumber` values
  (0–64, with gaps at 31 and 54–56). The IL2CPP dump lists the same names in the same order but has
  no values. **To verify in a raid:** select a known boss (Killa, Tagilla, ...) and check that the
  details panel's role line names it. Roles newer than `infectedTagilla` (64) show as "role N", so
  write down what they turn out to be and add them. Observed players have no role field: the
  frontend guesses from the voice preset (`Boss*`, `Sectant*`, `Scav_*`, and PMC voices on savage-side
  AI = raider/rogue).
- **Group:** `Profile.Info.GroupId` (or `TeamId`). The reference instead guessed groups once per raid by
  30 m proximity among human players, which finds nothing offline.
- **Level:** `Profile.Info.Level`, or experience plus the XP table.

Find these fields in the dump, add them to `eft.offsets.json`, and extend `buildPlayerLayout` (`game/eft/players/PlayerKinds.cpp`).

---

## 5. Frontend and server (M4)

### 5.1 Keep raid recordings
- **Do:** raids are recorded to `recordings/` automatically. Keep a few minutes of each map: they
  make realistic offline frontend work possible (`--offline`). Note what happened in each recording.
- **Check:** the "recorder: raid N done" log line at raid end gives lines and MB per message type.
  Note how many `lootDiff` lines a raid produces and how big the `loot` keyframes are: it decides
  whether the 60 s keyframe interval needs tuning.

### 5.2 Facing direction
- **Check:** in the frontend, compare your marker's facing line with where you look in game (north =
  up on a north-up map).
- **If it's off by 90° or mirrored:** the yaw convention assumption is wrong (see 4.3). Fix it in one
  place: the facing computation in `web/src/render.ts` (`Math.sin(yaw)`, `Math.cos(yaw)`), and update
  the yaw note in `docs/protocol.md`.

### 5.3 Map calibration
- **Do:** for each map, follow `docs/maps.md` ("Calibrating a new map"). Use at least 3 points far
  apart, then walk around and check the marker stays on the right spot across the whole map.
- **Floors:** set `maxY` per layer from heights observed in game (the backend logs your position
  every 5 s).

### 5.4 Remote viewing
- **Check:** if you want the radar on another device, start with `--listen 0.0.0.0:8080` and open
  `http://<host ip>:8080/`. There's no authentication: only do this on a trusted network.

---

## 6. Exfils (M5)

### 6.1 Exfils appear
- **Expect:** in the frontend (exfils layer), your side's usable exits plus secret ones, with names
  and status. With `--verbose`, "exfils: +regular 'name'" lines.
- **If no regular exfils, but secret ones appear:** the eligibility id is probably empty or doesn't
  match.
  - PMC: `Profile.Info.EntryPoint` (offset `PlayerInfo.EntryPoint`) against each exit's
    `EligibleEntryPoints`.
  - Scav: `Profile.Id` against `EligibleIds`.
  - The reference had the same "empty entry point → no regular exits" behaviour. If SPT doesn't set
    the entry point, consider showing all regular exits (unfiltered) as a fallback.
- **If none at all:** check `ClientLocalGameWorld.ExfiltrationController` and the
  `ExfiltrationController.*` array offsets.
- **Names:** these are the game's internal names (e.g. `Gate m`). A display-name table can come later
  (tarkov.dev `maps.extracts`, or SPT's locale files).
- **Status:** open (4), closed (1) and requirement (2) states should match the in-game exfil list.
  Exits opening mid-raid (e.g. after a timer) should change within about 1 s.
- **Transits** aren't shown. The reference used a static table of transit positions per map; that's
  frontend data to add later.

## 7. Explosives (M5)

- **Grenades:** throw one. **Expect:** a red dot with a ring that follows the grenade and disappears
  when it explodes. **If nothing shows up:** the grenade list sits at `GameWorld.Grenades` → `+0x18`.
  That's the JSON literal `GrenadeCollection.List`, an unnamed offset in the reference: find the real
  field in the dump. Also check `Throwable._isDestroyed`.
- **Tripwires:** find one (Woods, Customs). **Expect:** a red line between the anchors while it's
  armed. **Context:** tripwires are synchronizable objects with `Type == 2` (the
  `SynchronizableObjectType` enum value) and states 1/2 = armed (`ETripwireState` Wait/Active). Both
  enum values are constants in `Explosives.hpp`; verify them in the dump. The reference raised both
  endpoints by 0.175 m to match the visible wire.

## 8. Loot (M6)

- **Expect:** the loot/containers layers show loose items, containers (with names for known
  container types), corpses and airdrops. With `--verbose`, "loot: ignoring … of class X" lines for
  objects that aren't loot (doors, switches): normal.
- **Classification:** by runtime class including base classes: `Corpse` → corpse,
  `LootableContainer` → container (airdrop if the GameObject name contains `loot_collider`),
  `LootItem` → item (quest item if the template's `QuestItem` flag is set). The reference matched the
  exact live-only names `ObservedLootItem`, `LootableContainer`, `Corpse`/`ObservedCorpse`. If SPT's
  classes don't derive from these short names, update `Names.hpp`.
- **If loot appears but every item has the same or empty template id:** check `Item.Template`,
  `ItemTemplate._id` and the MongoID layout: the JSON literal `MongoID.StringId` (+0x10 within the
  struct).
- **Positions:** loot should sit where it is in game. An item picked up and dropped gets a new list
  entry, so it appears as new loot.
- **Item names and prices** come from tarkov.dev (live-EFT data). SPT uses the same template ids, so
  names match; prices reflect the live flea market, not SPT's. If item names show as raw ids, the
  browser couldn't reach `json.tarkov.dev` and had no cache (the status bar says "no item data").
- **Not implemented:** the "searched" state.

### 8.1 Contents and equipment
Click a container, corpse or player in the frontend to see the details panel.
- **Expect, slot contents:** weapons with their mods, magazines with cartridges, and equipment slots
  (`FirstPrimaryWeapon`, `TacticalVest`, `Backpack`, …), shown as template ids.
- **If nothing shows:**
  - Players: check `Player._inventoryController` → `InventoryController.Inventory` →
    `Inventory.Equipment` → `InventoryEquipment._cachedSlots`.
  - Corpses: `InteractiveLootItem.Item` (the equipment root) → `LootItemMod.Slots`.
  - Everything: `Slot.ID`, `Slot.ContainedItem`, `Item.StackObjectsCount`. Also check the class name
    `CompoundItem` (`Names.hpp`): only items of that class (or subclasses) are recursed into.
- **Grid contents (backpack, rig and container contents) won't show yet.** The reference never read
  grids, so their offsets are three `optional` entries with `null` values and **guessed** names:
  - `CompoundItem.Grids`: `EFT.InventoryLogic.CompoundItem` → `Grids` (array of grids);
  - `StashGrid.ItemCollection`: `EFT.InventoryLogic.StashGridClass` → `<ItemCollection>k__BackingField`;
  - `ItemCollection.Items`: the collection's item list, assumed a `List<Item>`.

  `update-offsets.py` fills them if the names match. Otherwise find the real chain in the dump: start
  from `CompoundItem`'s fields, look for the grid array, then from the grid class to where its items
  are stored. **If the items live in a dictionary** (e.g. item → grid location) rather than a list,
  `ItemTreeReader::readChildren` in `game/eft/items/ItemTree.cpp` needs a small change
  (`Managed::readDictionary` exists). Containers' contents are mostly grids, so until this works,
  containers look empty.

---

## 9. Not yet built

Items from the reference analysis to verify once the corresponding milestone exists:
- **Quests:** quest zone positions aren't in SPT's server database. Decide between a bundled
  tarkov.dev snapshot and reading trigger positions from the scene.
