# Design

The decisions and invariants behind the code. How things are implemented (intervals, retry counts,
which file does what) lives in the code and its comments.

## Goals and constraints

- **Read-only** radar for SP-Tarkov (offline). No writes, no input injection.
- The game runs in a **QEMU guest**. The radar runs on the **Linux host** and reads guest memory
  through VMM (MemProcFS) on top of LeechCore and its QEMU device plugin.
- The game build is **IL2CPP** (`GameAssembly.dll`).
- The map is **3D**, built from the game's own geometry (`docs/maps3d.md`), seen straight down
  during a raid; it can be tilted and turned for a closer look.
- Until verified against a real SPT build, game-reading behaviour follows what is known to work on
  live EFT (a reference implementation). Deviations get fixed once they're confirmed
  (`docs/verification-playbook.md`).

## Layers

```
web frontend (TS)         maps, markers, filters, item/quest names and prices, raid history, settings
      │  WebSocket (JSON), HTTP (static files, maps, recordings)
server/                   state stream, raid recordings
overlay/                  the player's view in a window over the game's picture (opt-in: --overlay)
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

**The overlay is a display client that runs inside the backend process.** `overlay/` draws the
player's view in a transparent, click-through window over the game's picture: a Wayland
layer-shell surface over the fullscreen Looking Glass client, on the host. It lives in the backend
only so it can read the camera right before every frame it draws (`CameraReader`, published by
`game/eft/camera/`). Going through the WebSocket would add a transport hop and the feed's polling
delay, and marks would trail behind when the player turns. Positions come from `WorldState` as
they are; at running speed, their age doesn't show.

What the overlay marks, and how (colour, label, emphasis), is not decided by the backend. The
frontend takes on a second job, configuring the overlay. It applies its own rules (the same ones
the map uses) and sends the result in an `overlay` message: the one client → server message, for
the overlay only. Nothing that reads the game depends on it, and the radar doesn't read it back.
The backend still doesn't interpret game data for presentation. The overlay adds only geometry:
where each marked thing is on screen now, and how far away it is.

- **Frames:** drawn when the compositor's frame callback asks for one, without waiting for vsync;
  nothing is drawn while the overlay is off or there's no camera.
- **Players:** their full skeleton (limbs and head, as the map draws figures) when it's readable;
  otherwise, or when the figure would be under 30 px tall, a line from the feet to head height.
- **Delay:** Looking Glass shows the game's picture a little after the game rendered it, while
  the camera is read as it is now. A configurable delay draws with the camera reading from that
  long ago.
- **Scope:** while scoped, marks inside a circle (the scope's picture, size configurable) are
  placed through the scope's camera; marks outside it go through the first-person view.
- **Window:** layer-shell is supported by KDE Plasma and the wlroots compositors, not GNOME.
  `radar-overlay-demo` shows the window with a made-up scene, for checking it without the game.

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
- **Players are built as soon as they're registered**: up to 16 new entries per roster tick (20 ms),
  failed ones retried every 500 ms, then every 2 s after 10 failures, for as long as they stay
  registered. A build fails rather than accept
  a side other than USEC, BEAR or Savage (a misread object would become a phantom player). The
  roster is only believed empty after two empty reads in a row.
- **Positions come from skeleton bones**, read in one batch for all players. There's no usable
  position field. Any of the 3 position bones is enough to track a player (some bodies, e.g.
  zombies, get bones late); a partly resolved skeleton is resolved again every 250 ms, every 2 s
  after 8 tries.
- **Body joints come from the same read.** 17 joints (`kJointSources` in
  `game/eft/players/Skeleton.hpp`) share one transform hierarchy per player, so they cost little
  more than the 3 position bones. A player gets either every joint or none. The bone indices are
  checked by name with `--diagnose` (its Skeleton section lists every bone).
- **Skeletons are their own message** (`skeletons`, whole cm relative to the position), sent just
  before the `players` of the same snapshot, so the recorder can keep fewer of them (5/s) than of
  positions. The frontend's timeline stores them per player (thinned to one per 150 ms) and draws
  players close up as figures on the marker canvas, through the 3D camera: no extra map frames,
  but no occlusion by the map either.
- **The camera is read but not drawn by the radar.** `game/eft/camera/` follows the first-person
  camera, aiming, sights and their zoom, and the scope's camera while scoped (`camera` message), so
  clients can render the player's view. The Unity part (camera list, matrices) is in
  `core/unity/Camera`. The frontend's experimental POV page (`#pov`) shows it.
- **Ids, not addresses.** Players and loot get small integer ids, stable within a raid. Addresses
  never leave the backend.
- **Loot is classified by runtime class**, including base classes, so SPT subclasses still match.
- **Item trees** (player and corpse equipment) are read with depth/node caps so one read stays
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

## Frontend: what shows, and how

- **Rows** (`web/src/list/rows.ts`). Everything the radar knows becomes one row per thing (what it is,
  the items it is or carries, its value). Display rules, highlights and list filters all match rows.
- **Display rules** (`web/src/rules/`) decide how each thing looks and whether and when it shows: one
  ordered list of rules, each a match (`web/src/highlight/match.ts`) and the style properties it sets
  (visibility from a level of detail on, colour, emphasis, label, ring). A thing starts from its kind's
  base style; every rule that matches sets its properties on top, later rules winning property by
  property. Bottom to top: the built-in rules (looks by player type, loose items by value, the other
  kinds of things), groups switched off (the old map layers), standing rules (pinned highlights), then
  highlights from the global search; so standing rules and highlights beat anything that hides. Map,
  figures, trails, picking and the list all read the result.
- **The Map view edits the rules** (`web/src/components/MapPanel.tsx`). Built-in rules can be changed
  and reset, not removed; only the changes are stored (`web/src/rules/store.ts`, by rule id), so
  changed defaults in code still reach every rule nobody touched. Loot density and the label
  threshold are no settings of their own: they are the item rules' "shown" and "label".
- **Not rules, on purpose:** each kind's shape and what an emphasis means for it (`web/src/style.ts`),
  a thing's state (the dead are grey, those who left faded, an exfil's colour is its status), the local
  player, and where labels go.
- **List filters** (per tab) hide; the map follows each tab's filter for its own kind of thing.
- **What shows when** (`web/src/declutter.ts`): the levels of detail behind loot density and labels,
  and in which order labels claim screen space (one placement pass for all labels, `render.ts`).

## Offsets

- **Single source of truth:** `game/eft/offsets/eft.offsets.json`, turned into constants at build
  time. Nothing is loaded at runtime: SPT updates are rare, and regenerating plus rebuilding is
  simpler. Unknown offsets can be `optional`; the feature is skipped until they're filled in.
- **Generated, not hand-maintained:** a dump of every IL2CPP class feeds a script that fills the
  file by class and field name (`docs/offset-tools.md`).
- **A build fingerprint mismatch is only a warning.** In the worst case results are wrong; often an
  update didn't touch the classes we read.
