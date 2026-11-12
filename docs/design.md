# Design

The decisions and invariants behind the code. How things are implemented (intervals, retry counts,
which file does what) lives in the code and its comments.

## Goals and constraints

- **Read-only** radar for SP-Tarkov (offline). No writes, no input injection.
- The game runs in a **QEMU guest**. The radar runs on the **Linux host** and reads guest memory
  through VMM (MemProcFS) on top of LeechCore and its QEMU device plugin.
- The game build is **IL2CPP** (`GameAssembly.dll`).
- **2D radar** first. An angled (3D-projected) view may come later.
- Until verified against a real SPT build, game-reading behaviour follows what is known to work on
  live EFT (a reference implementation). Deviations get fixed once they're confirmed
  (`docs/verification-playbook.md`).

## Layers

```
web frontend (TS)         maps, markers, filters, item/quest names and prices, raid history, settings
      │  WebSocket (JSON), HTTP (static files, maps, recordings)
server/                   state stream, raid recordings
game/eft/                 everything EFT-specific: names, offsets, raid lifecycle, subsystems
core/unity, core/il2cpp   Unity engine structures; IL2CPP managed objects (game-agnostic)
core/mem                  memory backend interface, Target (attaching)
backend                   VMM (QEMU device or dump file), fake backend (tests)
```

`core/` knows Unity and IL2CPP but nothing about EFT. Swapping game builds or data sources is a
code change in `game/eft/` (or in the frontend for item/quest data), behind stable interfaces.

**The backend reports facts; the frontend presents them.** The backend sends positions, states and
template/quest/condition ids. The frontend owns names, prices, categories, loot filters, quest →
zone mapping, and everything derived from history (trails, event log, replay). Nothing in the
backend's reading depends on item data.

## Memory access

- **Failed reads zero-fill.** Most consumers follow pointer chains, where 0 already means
  "invalid".
- **A complete read proves nothing.** With VMM, an unreadable guest page can come back zero-filled
  and still be reported as read. Readers validate what they read (pointer range, counts, finite and
  plausible values).
- **One pointer-validity rule** for every pointer read from game memory.
- **Strings from memory are sanitised to valid UTF-8** before they can reach JSON.
- **Attaching is one owner's job.** Every (re)attach bumps a generation; consumers drop derived
  pointer caches when it changes.
- **Offline development:** raw physical memory dumps open through the same VMM backend; every raid
  is recorded and can be replayed in the frontend; unit tests run against the fake backend.

## Raid lifecycle and threading

One lifecycle thread runs the top-level state machine: waiting for the process/modules → waiting
for a raid → in raid → cooldown → waiting for a raid.

- **Finding a raid:** a cheap strategy first (the local player via a static field, reached through
  the IL2CPP type-info table), and a full scene scan for "GameWorld" as a slow fallback. A candidate
  must be on a known raid location, with a local player and a non-empty roster; otherwise it's
  "pending" (loading).
- **Ending a raid** is a heuristic, because the game doesn't reliably clear a finished world: the
  roster empty or unreadable for a while, the local player moving to another world, or the process
  going away.
- **The ended raid's world is refused** while it still looks like a running raid, so the post-raid
  screen isn't taken for a new raid. The guard lifts once the world is seen torn down (a new raid may
  reuse the address), or after it looked ready long enough that the end was probably false.
- **Per-raid subsystems** (players, exfils, explosives, loot) are created at raid start and destroyed
  after their worker threads are joined, so no state carries over between raids. They schedule tasks
  on a high-rate `live` thread and a `background` thread.
- **Everything crossing threads is an immutable snapshot** published through an atomic `shared_ptr`.

## Game data

- **Player kinds.** Roster entries come in two object layouts: full `EFT.Player` objects (ours, and
  bots simulated in this client) and `ObservedPlayerView` network replicas (players and bots
  simulated elsewhere). Each kind resolves its own addresses; everything after that is shared.
- **Positions come from skeleton bones**, read in one batch for all players. There's no usable
  position field.
- **Body joints come from the same read.** 17 joints (`kJointSources` in
  `game/eft/players/Skeleton.hpp`) share one transform hierarchy per player, so they cost little
  more than the 3 position bones. A player gets either every joint or none. The bone indices are
  checked by name with `--diagnose` (its Skeleton section lists every bone).
- **Ids, not addresses.** Players and loot get small integer ids, stable within a raid. Addresses
  never leave the backend.
- **Loot is classified by runtime class**, including base classes, so SPT subclasses still match.
- **Item trees** (container contents, equipment) are read with depth/node caps so one read stays
  bounded.
- **Item data comes from tarkov.dev**, fetched and cached by the browser (the feeds allow
  cross-origin requests), behind an interface so another source (the SPT server database) can
  replace it.

## Server

- `MessageHub` keeps the latest message per type, so a new client gets the full state on connect.
- Every raid is recorded (the message stream, one file per raid). The frontend builds trails, the
  event log and replay from these files; a client joining mid-raid fills in history from the active
  recording.
- Listens on localhost by default. WebSocket upgrades are only accepted from pages served by the
  same host (`Origin` must match `Host`), so other websites can't read the stream. Static files are
  served with path checks.
- **Known gap:** no per-client send backpressure (Crow doesn't expose its queue), so a stalled
  client's buffer can grow. Fine on localhost; revisit for LAN use.

## Offsets

- **Single source of truth:** `game/eft/offsets/eft.offsets.json`, turned into constants at build
  time. Nothing is loaded at runtime: SPT updates are rare, and regenerating plus rebuilding is
  simpler. Unknown offsets can be `optional`; the feature is skipped until they're filled in.
- **Generated, not hand-maintained:** a dump of every IL2CPP class feeds a script that fills the
  file by class and field name (`docs/offset-tools.md`).
- **A build fingerprint mismatch is only a warning.** In the worst case results are wrong; often an
  update didn't touch the classes we read.
