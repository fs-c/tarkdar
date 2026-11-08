# Design

The project's own design notes. Code comments may refer to sections here.

## Goals and constraints

- **Read-only** radar for SP-Tarkov (offline). No writes, no input injection.
- The game runs in a **QEMU guest**. The radar runs on the **Linux host** and reads guest memory
  through VMM (MemProcFS) on top of LeechCore and its QEMU device plugin.
- The game build is **IL2CPP** (`GameAssembly.dll`).
- **2D radar** first. An angled (3D-projected) view may come later.
- Until verified against a real SPT build, game-reading behaviour follows what is known to work on
  live EFT. Deviations get fixed once they're confirmed.

## Layers

```
web frontend (TS)      maps, markers, filters, item/quest names and prices, settings
      │  WebSocket (JSON), HTTP (static files, maps, data)
server/                state stream, recording/replay of the stream
game/eft/              everything EFT-specific: names, offsets, raid lifecycle, subsystems
core/unity, core/il2cpp   Unity engine structures; IL2CPP managed objects (game-agnostic)
core/mem               IMemoryBackend, MemoryView, Target
backend                VmmBackend (QEMU device or dump file), FakeBackend (tests)
```

`core/` knows Unity and IL2CPP but nothing about EFT. Swapping game builds or data sources is a
code change in `game/eft/` (or in the frontend for item/quest data), behind stable interfaces.

**The backend reports facts; the frontend presents them.** The backend sends positions, states and
template/quest/condition ids. The frontend owns names, prices, categories, loot filters and quest →
zone mapping. Nothing in the backend's reading depends on item data.

## Memory access

- **Failed reads zero-fill.** Every read zero-fills bytes it couldn't read. Batched reads report
  `bytesRead` per request, which VMM provides at no extra cost. Most consumers follow pointer
  chains, where 0 already means "invalid".
- **`bytesRead` is a weak signal.** With VMM, an unreadable page inside the guest's physical memory
  can come back zero-filled and still be reported as read. So readers validate what they read
  (pointer range, counts, finite and plausible values) rather than trusting a complete read.
- **Strings from memory are sanitised to valid UTF-8** before they can reach JSON.
- **One pointer-validity rule** (`MemoryView::isUserPointer`) for every pointer read from game
  memory.
- **`Freshness` is a hint:** `Fresh` bypasses VMM's cache for anything that changes in-game.
- **`Target` owns attaching.** It finds the process, waits for the required modules, and bumps
  `generation` on every (re)attach. Consumers drop derived pointer caches when it changes.
- **Offline development:**
  - **Raw physical memory dumps:** `tools/mem-dump` writes one; open it with `VmmBackend` (same
    code, different device string).
  - **Stream recordings:** record the WebSocket stream and replay it, for frontend work with nothing
    else running.
  - **Unit tests:** run against `FakeBackend`.
  - **Later:** a Recording/ReplayBackend for moving game state.

## Raid lifecycle

`game/eft/Lifecycle` runs the top-level state machine on one thread:
waiting for the process/modules → waiting for a raid → in raid → cooldown (3 s) → waiting for a raid.

**Finding a raid** (`raid/RaidFinder`, polled every 2.5 s). Strategies, in order:

1. **Type-table static:** `GamePlayerOwner._myPlayer` (a static field, reached through the IL2CPP
   type-info table), then `Player.GameWorld`.
2. **Scene scan:** active GameObjects named "GameWorld", then their `EFT.GameWorld` component (found
   by class, not by component index). It walks the whole object list, so it runs only after 6 s of
   searching, then at most every 20 s.

A candidate world passes when all of these hold:
- its LocationId (falling back to the local player's `Location`) is a known raid location (`Maps.hpp`);
- it has a local player;
- its RegisteredPlayers list is non-empty.

A world that is on a raid location but not ready yet is "pending". It is retried for up to 6 polls.

The world of the raid that just ended is refused while it still looks like a running raid. Once it
has been seen torn down, the guard lifts, so a new raid that reuses the address is accepted.

**In a raid:**
- A `RaidSession` (immutable: id, world, local player, location) is shared with the per-raid
  `RaidSubsystem`s.
- Subsystems register tasks on two worker threads: `live` for high-rate work, `background` for the
  rest. Each thread runs a `sched::TaskRunner`, which keeps each task's phase and skips missed
  cycles.
- Subsystems are created at raid start and destroyed after their workers are joined, so no state
  carries over between raids.

**Raid end** is checked every 800 ms on the lifecycle thread (`raid/RaidMonitor`, state per raid).
The raid ends on any of:
- the roster read empty for 12 consecutive checks (after it was non-empty at least once);
- the roster unreadable for 10 consecutive checks;
- the roster never filling within 2 minutes;
- the local player (`GamePlayerOwner._myPlayer`) belonging to a different GameWorld for 3 consecutive
  checks. The game doesn't necessarily clear a finished world's roster, so this catches the next raid
  (or the hideout) taking over. It only applies once `_myPlayer` has been seen pointing at this
  raid's world;
- the game process gone, or a re-attach. These end the raid immediately.

The ended raid's world is refused by the finder while it still looks ready. In case the end was
false, the guard lifts once the world has looked ready continuously for 30 s.

**Shared state:** everything crossing threads is an immutable snapshot published through an atomic
`shared_ptr` (`sched::Published`, `Lifecycle::session()`).

## Players

`game/eft/players/Players` is a raid subsystem with two tasks on the live thread, so its state needs no
locking.

**Roster task (20 ms):**
- Reads the registered-player list.
- Builds new players: at most 4 attempts per tick; a failing player is retried freely 5 times, then
  every 2 s.
- Only objects whose class derives from `EFT.Player` are tracked. That's every player in an offline
  raid. The online-only `ObservedPlayerView` isn't supported.
- Refreshes rotation (every tick) and the corpse pointer (every 100 ms; non-null means dead, and death
  is permanent).
- Players missing from the list for ≥ 3 ticks and ≥ 2 s become "absent".

**Positions task (10 ms):**
- Position comes from skeleton bones: Base, else the midpoint of the feet, else one foot.
- The bones of all players are read in one batched `Transforms::worldPoses` call.
- An implausible skeleton drops the cached bone pointers so they get resolved again.

**Output:**
- Publishes `WorldState::players` (`model/Players.hpp`) after every change.
- Player ids are small integers, stable within a raid; addresses never leave the backend.
- `WorldState` lives for the whole process; the subsystem clears its snapshot when destroyed at raid
  end.

## Exfils, explosives, loot

Raid subsystems in `game/eft/world/`, each publishing into `WorldState`.

**`Exfils`** (background thread):
- Discovery runs every 8 s and merges; entries are never removed during a raid.
- Regular exfils come from the PMC or scav list, according to the local player's side. They're
  filtered by eligibility: PMC entry point vs `EligibleEntryPoints`, scav profile id vs `EligibleIds`.
- Secret exfils are added unfiltered.
- Positions are read once; status is refreshed every 1 s.

**`Explosives`** (live thread):
- Grenades are polled every 100 ms from the GameWorld's grenade list, until `_isDestroyed` is set or
  they leave the list.
- Tripwires are polled every 20 ms from the synchronizable-object lists (`Type == 2`) and shown while
  armed.

**`Loot`** (background thread):
- Scans the LootList every 3 s; new entries become pending.
- Resolves pending entries in chunks (256 every 250 ms) with retry and back-off.
- Classifies by runtime class (and base classes): `Corpse`, `LootableContainer` (airdrops by
  GameObject name), `LootItem` (quest items by the template's flag). The class names live in
  `Names.hpp`.
- Reports template ids and positions. Positions are read once, except airdrops, which are re-read
  every scan.
- Entries missing from 2 consecutive scans are removed. If the list suddenly shrinks to under half,
  nothing is removed that scan (a torn read).
- Containers carry their contents and corpses their equipment, as item trees. They're read at resolve
  time and refreshed for 16 entries per scan, round-robin.

**Item trees** (`game/eft/items/ItemTree`):
- Read an item's template id and stack count.
- For compound items only (class or base class `CompoundItem`), recurse into `Slots` (weapon mods,
  magazine cartridges, equipment slots) and into `Grids` (container, backpack and rig contents).
- The grid offsets are **optional** entries in the offsets file. They aren't known yet (the reference
  never read grids), so grids are skipped until they're filled in.
- Depth, node and slot caps keep a single read bounded.

**Player equipment:** a background task in `Players` reads up to 2 players' equipment trees every
500 ms, each player at most every 5 s, and publishes `WorldState::equipment`. It gets the roster from
an internally published list, so it shares no mutable state with the live tasks.

**Item data** (`web/src/catalog.ts`): names and prices by template id from tarkov.dev's JSON API.
- **Feeds:** `json.tarkov.dev/pvp-season/items` (names are translation keys) and `.../items_en` (the
  English texts).
- **Fetched by the browser** (the feeds allow cross-origin requests) on page load.
- **Slimmed and cached:** reduced to id → name, short name and price (about 430 KB) and cached in
  `localStorage` for 24 h. The full download (about 2 MB compressed) happens at most once a day.
- **Price:** `avg24hPrice` (24 h flea average). For items without flea data, including currencies,
  it falls back to `basePrice`; the UI marks those as base prices.
- **On a failed download:** a stale cache is used; with no cache, items show as template ids.
- **Container names** come from a small static table (containers aren't items in tarkov.dev's data).
- **Swappable:** the catalogue sits behind the `ItemCatalog` interface, so another source (the SPT
  server database) can replace it.

## Server and frontend

**Server (`server/`, Crow):**
- `LiveFeed` polls the lifecycle status and `WorldState` about 30 times per second and broadcasts
  whatever changed through `MessageHub`.
- `MessageHub` remembers the latest message per type, so new clients get the full state on connect.
- The hub can be tapped to record the stream (`StreamRecorder`), and `StreamReplay` can feed it from a
  recording instead of a game.
- The message format is in `docs/protocol.md`.
- Static files (frontend, maps, data) are served with path checks (`resolveUnder`).
- WebSocket upgrades are only accepted from pages served by the same host (the `Origin` must match
  `Host`). That stops any other website open in the browser from reading the stream. Incoming frames
  are capped at 64 KB.
- **Known gap:** there's no per-client send backpressure (Crow doesn't expose its queue), so a stalled
  client's buffer can grow. That's fine on localhost; revisit for LAN use.

**Frontend (`web/`, TypeScript + Vite, Canvas 2D, no framework):**
- `connection.ts` keeps the latest state from the WebSocket (with reconnect).
- `maps.ts` loads map folders and picks floors by height.
- `calibration.ts` fits the world ↔ image transform from control points.
- `render.ts` draws the map, players and markers.
- `main.ts` handles the view (zoom, pan, follow) and calibration mode. The map format is in
  `docs/maps.md`.
- Facing directions go through the map transform, so rotated map images work.
- With no map for the location, the frontend draws a world-coordinate grid instead of borrowing
  another map's calibration.

## Offsets

- **Single source of truth:** `game/eft/offsets/eft.offsets.json` holds names and values. Entries
  marked `"optional": true` may have a `null` value. They become `std::optional<std::uint32_t>`
  constants, and the code skips the feature while they're unknown. At build
  time `cmake/gen_offsets.py` turns it into `off::<Group>::<Name>` constants. Nothing is loaded at
  runtime: SPT updates are rare, and regenerating plus rebuilding is simpler than runtime offset
  loading.
- **Updating offsets:**
  - `il2cpp-dump` writes every IL2CPP class (parent, fields, static flags), plus the Unity globals and
    the module fingerprints, to a JSON dump.
  - `tools/update-offsets.py` fills the offsets file from that dump by class and field name.

  See `docs/offset-tools.md`. The dump doubles as an offline reference for exploring the game's
  classes.
- **Build fingerprint check:** the JSON records the PE build fingerprint (timestamp, image size) of
  the game modules the offsets were made for. A mismatch at attach is **only a warning**. In the
  worst case results are wrong; often an update didn't touch the classes we read.

## Open decisions

- **Privilege model.** Opening QEMU's memory needs root or the QEMU process's user, and the HTTP
  server shouldn't run as root. Options:
  - run as the QEMU user;
  - a narrow capability;
  - a small privileged helper that passes the memory fd over a Unix socket.
- **Dump format:** `tools/mem-dump` writes raw dumps; whether VMM opens them on the real setup is
  unverified (fallback: QEMU `dump-guest-memory`).
- **Where frontend settings persist** (once there are any): browser storage or a JSON file via the
  API.
