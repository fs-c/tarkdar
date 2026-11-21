# Backend ↔ frontend protocol

Version **1** (`server/Protocol.hpp` `kProtocolVersion`, `web/src/model/protocol.ts` `PROTOCOL_VERSION`).
Bump both when a change isn't backwards compatible.

## Transport

`radar-backend` serves HTTP and a WebSocket on one port (default `127.0.0.1:8080`; `--listen` to
change, e.g. `0.0.0.0:8080` for LAN access).

| Route | Content |
|---|---|
| `GET /ws` | WebSocket: the message stream below, plus one client → server message (`overlay`). |
| `GET /maps/index.json` | Generated list of the map folders under `maps/3d`: `[{"folder": "...", "config": {map.json contents}}]`, sorted by folder. See `docs/maps3d.md`. |
| `GET /maps/3d/<folder>/<file>` | Map files: the 3D datasets. |
| `GET /data/<path>` | Item/quest data files (not used yet). |
| `GET /api/recordings` | Raid recordings, newest first (below). |
| `GET /api/recordings/<name>` | One recording file, as stored (`.jsonl`, or `.jsonl.gz` as `application/gzip`: the client unpacks it). The active one is flushed first. |
| `GET /`, `GET /<path>` | The built frontend (`web/dist`). |

Static files are only served from inside their root directory. Paths that resolve outside it (`..`,
symlinks) get a 404.

## Messages

JSON text frames, one message each, all with the same envelope:

```json
{ "type": "players", "raid": 3, "rev": 1042, "t": 1794174689050, "data": { ... } }
```

| Field | Meaning |
|---|---|
| `type` | Message type (below). |
| `raid` | Raid id (increments per raid within one backend run), or `null` outside a raid. |
| `rev` | Revision of this message type's data; increases with every change. For `status`, the attach generation. |
| `t` | Send time, ms since the Unix epoch. Used for replay timing. |
| `data` | Type-specific payload. |

On connect, the server sends `hello`, then the **latest message of every type** (`status` first,
the rest in the order they were sent), so a client connecting mid-raid gets the full current state
at once. Messages of a raid that has ended (a `status` for another raid or none followed) aren't
replayed. After that, messages are sent when the data
changes, at most about 30 times per second.

### `hello`
```json
{ "protocol": 1, "live": true, "overlay": false }
```
- **`live`:** false when the backend has no memory source (`--offline`): only recordings to show.
- **`overlay`:** the backend runs the overlay window (`--overlay`) and takes `overlay` messages.

### `status`
```json
{ "state": "inRaid", "raidPending": false, "locationId": "bigmap", "offsetsMismatch": false }
```
- **`state`:** one of `waitingForProcess`, `waitingForModules`, `waitingForRaid`, `inRaid`,
  `cooldown`.
- **`raidPending`:** while waiting for a raid, a raid world exists but isn't ready yet (loading).
- **`locationId`:** the game's location id (e.g. `bigmap`, `factory4_day`); `null` unless `inRaid`.
- **`offsetsMismatch`:** the loaded game build differs from the build the compiled-in offsets were
  made for. Data may be wrong.

### `players`
```json
{ "players": [
  { "id": 1, "local": true, "kind": "local", "ai": false, "side": "usec", "dead": false, "absent": false,
    "pos": [12.5, 3.1, -40.2], "yaw": 271.4, "pitch": -3.0 },
  { "id": 2, "local": false, "kind": "observed", "ai": true, "side": "savage", "voice": "BossKilla",
    "dead": false, "absent": false, "pos": [40.0, 3.0, -12.0], "yaw": 90.0, "pitch": 0.0 }
] }
```
- **`id`:** small integer, stable within a raid and never reused in it.
- **`local`:** the player whose game this is.
- **`kind`:** the object layout the backend read: `local` (ours), `client` (a bot simulated in this
  game client) or `observed` (a network replica of a player or bot simulated elsewhere).
- **`ai`:** always true for `client`; observed players carry the game's own flag.
- **`voice`:** observed players only (omitted otherwise): the voice preset, which names bot roles and
  bosses.
- **`role`:** the raw `EFT.WildSpawnType` value (e.g. 1 = assault, 6 = bossKilla); omitted if unread.
  Mapping values to names is the frontend's job (`web/src/model/roles.ts`). Full players (`local`,
  `client`): `Profile.Info.Settings.Role`. Observed players: `ObservedPlayerView.AIData` →
  `BotHostilityData._role`, which is **unverified** (check with `radar-diagnose` in a raid) and may only
  appear a few seconds after the player does; in recordings up to 2026-11 it was never read for an
  observed player. Only meaningful for AI: humans carry a default (our own PMC reads 1, assault).
- **`nickname`:** the player's nickname (bosses carry their name); omitted if empty.
- **`groupId`:** players spawned together share it (a boss and its guards, a PMC squad); omitted if
  empty. Observed AI never had one in recordings up to 2026-11: the frontend finds a boss's guards by
  where and when they first appear instead (`spawnGroup`, `web/src/stream/timeline.ts`).
- **`side`:** `usec`, `bear`, `savage` (scavs, bosses and other non-PMC bots) or `unknown`.
- **`dead`:** permanent once set; the player keeps its last position.
- **`absent`:** left the game's player list without dying (extracted or despawned).
- **`pos`:** world position in metres, Unity axes `[x east, y up, z north]`, centimetre precision.
  `null` until known.
- **`yaw`, `pitch`:** look direction in degrees, as stored by the game. Assumed: yaw 0 = +z (north),
  90 = +x (east). This is unverified.

The whole list is sent on every change (players are few; positions change every tick anyway).

### `skeletons`
```json
{ "players": [ { "id": 1, "j": [0, 0, 0, -15, 6, 4, 15, 4, -3, 1, 95, 2, ...] } ] }
```
Body joints of the alive, present players whose whole skeleton is readable, from the same snapshot as
the `players` message (same `rev`, sent right before it; not sent while no player has joints).
- **`j`:** 17 joints × `[x, y, z]`, in whole centimetres relative to the player's `pos`, Unity axes.
  Joint order: base (floor level), left foot, right foot, pelvis, chest, neck, head, left hip, left
  knee, right hip, right knee, left shoulder, left elbow, left hand, right shoulder, right elbow,
  right hand (`eft::Joint`).
- A player missing from the list has no usable skeleton right now (draw a plain marker).

### `exfils`
```json
{ "exfils": [ { "id": 1, "kind": "regular", "key": "ex_customs_pmc_zb1011", "name": "ZB-1011", "status": 4, "pos": [180.0, 0.0, 150.0] } ] }
```
- **`kind`:** `regular` (only the ones the local player can use) or `secret`.
- **`key`:** the game's internal exit name (`ExitSettings.Name`).
- **`name`:** its name in the game's own texts (the client's language, else English), or `key` if it
  has none. Recordings from before `key` existed have the internal name here.
- **`status`:** the game's `EExfiltrationStatus`: 1 closed, 2 requirements not met, 3 countdown,
  4 open, 5 pending, 6 awaiting manual activation.
- **`pos`:** `null` if the position couldn't be read.

### `explosives`
```json
{ "grenades": [ { "id": 2, "pos": [-5.0, 0.5, 20.0] } ],
  "tripwires": [ { "id": 1, "from": [-60.0, 0.2, -10.0], "to": [-52.0, 0.2, -4.0] } ] }
```
Thrown grenades (all types alike) until they explode, and armed tripwires.

### `vehicles`
```json
{ "vehicles": [ { "id": 1, "kind": "btr", "state": 2, "pos": [128.3, 2.8, 251.4], "yaw": -96.0,
                  "occupants": [ { "player": 1, "seat": "passenger" }, { "player": 21, "seat": "gunner" } ] } ] }
```
Vehicles on the map; so far only the BTR, from when it spawns until it's gone. Empty on maps without one.
- **`state`:** the vehicle's own state. BTR: 0 stopped, 1 stopped (paid ride), 2 driving.
- **`yaw`:** heading in degrees, same convention as a player's `yaw` (0 = +z, 90 = +x).
- **`occupants`:** players aboard, by player `id`. `gunner`: the bot on the BTR's turret (an ordinary
  player in `players`, usually with a scav voice). `passenger`: players getting in, sitting inside or
  getting out.
- Sent when something changes; a moving vehicle at most every 100 ms (moves under 0.1 m and turns
  under 1° aren't sent).

### `quests`
```json
{ "quests": [ {
  "id": "5969f90786f77420d2328015", "status": 2, "done": [ "5969f98286f774576d4c9542" ],
  "name": "Charity", "trader": "54cb57776803fa99248b456e", "kind": "side",
  "objectives": [
    { "id": "5969f98286f774576d4c9542", "type": "find", "items": [ "5c10c8fd86f7743d7d706df3" ], "count": 5, "fir": true,
      "text": "Find the item in raid: Adrenaline injector" },
    { "id": "5969f99286f77456630ea442", "type": "handover", "items": [ "5c10c8fd86f7743d7d706df3" ], "count": 5, "fir": true,
      "progress": 3, "text": "Hand over the items" }
  ] } ] }
```
The local player's quests in progress (`Profile.QuestsData`); `null` until they've been read.
- **`status`:** the game's `EQuestStatus`: 2 started, 3 ready to hand in (other quests aren't sent).
- **`done`:** ids of the quest's conditions (objectives) already completed; `null` if unreadable.
- From the quest's template in game memory (`QuestStatusData.Template`); `objectives` is `null` when
  it couldn't be read (and missing in older recordings), and then the other fields are missing too:
  - **`name`:** name in the player's language (the game's own texts), if it has one (repeatables and most
    story steps don't).
  - **`trader`:** trader id; story quests belong to the story's pseudo-trader `67f7af56c117b6140af2a607`.
  - **`kind`:** `story` (1.0 storyline: main quests and the story trader's), `side`, `daily` or `weekly`
    (repeatables, by how long they run).
  - **`hidden`:** `true` for quests not in the quest list (hidden story steps).
  - **`objectives`:** the item objectives (conditions to hand the quest in): `find`, `handover` or
    `plant` any of `items` (template ids), `count` of them, `fir` if found in raid only. `progress`:
    handed over so far (hand-over objectives the profile has a counter for). `text`: its text, in the player's language.
- Sent when something changes (read every 2 s; templates once per quest).

### `stash`
```json
{ "profile": "6a70cdb209bbcad9180d7eb4",
  "stash": [ { "tpl": "5449016a4bdc2d6f028b456f", "count": 6293201 },
             { "tpl": "5c10c8fd86f7743d7d706df3", "count": 4, "fir": 3 } ],
  "equipment": [ { "tpl": "5c0e655586f774045612eeb2", "count": 1 } ] }
```
What the PMC owns, per template id; `null` until it's been read. From the menu-side profile
(`ClientBackendSession._profile`; the in-raid `Player.Profile` has no stash), so it's the stash as it
was when the raid started.
- **`profile`:** the profile's id (to keep a copy per profile).
- **`stash`:** everything in the stash, sorting table, quest stash and hideout area stashes, nested
  items included (contents of cases, attached mods). **`count`:** stack units in total; **`fir`:** how
  many of them are found in raid (missing: 0).
- **`equipment`:** the same for the profile's equipment: in a raid, what the character took in (the
  current gear is the local player's `equipment`).
- Read every 30 s; sent when something changes.

### `camera`
```json
{ "fps": { "vp": [ 16 numbers ], "pos": [ 120.4, 3.1, -88.2 ], "fov": 75, "aspect": 1.7778 },
  "aiming": true, "scoped": true, "magnification": 4,
  "sights": [ { "scope": 0, "mode": 0, "zoom": 1, "min": 1, "max": 1, "magnified": false, "current": false },
              { "scope": 0, "mode": 1, "zoom": 4, "min": 1, "max": 4, "magnified": true, "current": true } ],
  "active": 1,
  "optic": { "vp": [ 16 numbers ], "pos": [ 120.5, 3.1, -88.0 ], "fov": 6.2, "aspect": 1 } }
```
The local player's view, for clients that render what the player sees. Experimental: the offsets
behind it are unverified on SPT (`radar-diagnose`, section Camera).
- **`fps`:** the first-person camera, `null` while not found or unreadable. **`vp`** is its
  view-projection matrix (Unity `Matrix4x4`, column-major: element `row + 4 × column`): a world point
  `(x, y, z, 1)` times it gives clip coordinates `(cx, cy, cz, w)`; the point is in front of the camera
  when `w > 0`, and on screen at `(cx / w, cy / w)` within −1…1 (y up). `pos` (world position), `fov`
  (vertical, degrees) and `aspect` (width / height) are left out when unknown.
- **`aiming`:** aiming down sights. **`sights`** (only while aiming): the weapon's sights in order;
  `zoom` is the current magnification (variable scopes: the live zoom), `min`/`max` the sight's zoom
  range, `magnified` whether it's noticeably above 1×, `current` whether the game looks through it.
  **`active`** is the index of the sight looked through (`null` when not aiming).
- **`scoped`:** aiming through a magnified sight; **`magnification`** is the active sight's zoom (1
  when there's none). While scoped, **`optic`** is the scope's own camera (same fields as `fps`): its
  matrix projects the narrow view inside the scope; otherwise `null`.
- Sent when something changes (read about 60 times per second, so while the player moves, at the
  full message rate).

### `loot`
```json
{ "loot": [ { "id": 7, "kind": "container", "tpl": "578f8782245977354405a1e3", "obj": "container_safe", "pos": [3.0, 1.0, 3.0] } ] }
```
- **`kind`:** `item`, `quest` (quest item: the template's quest flag, as it is; the battle-pass info
  documents, `obj` `item_barter_info_*`, carry it too and the frontend treats them as items),
  `container`, `airdrop` or `corpse`.
- **`tpl`:** the item or container template id (the key for item data); empty for airdrops and
  corpses.
- **`obj`:** the GameObject name, for debugging.
- **`contents`** (optional): for corpses, their equipment, a list of item nodes (below). Container
  contents aren't read (recordings from older backends may still have them; the frontend ignores them).

Sent after every loot scan or resolve that changed something (a few thousand entries at most).

### `equipment`
```json
{ "players": [ { "id": 4, "slots": [
  { "tpl": "5bb2475ed4351e00853264e3", "slot": "FirstPrimaryWeapon", "items": [
    { "tpl": "55d4887d4bdc2d962f8b4570", "slot": "mod_magazine", "items": [
      { "tpl": "54527a984bdc2d4e668b4567", "slot": "cartridges", "count": 30 } ] } ] } ] } ] }
```
Equipment per player id (players without readable equipment are omitted). Players are re-read every
few seconds; the message is sent when something changed.

### Item nodes
`{ "tpl": template id, "slot": slot id (if in a slot), "count": stack size (if > 1), "fir": true (if
found in raid), "items": [child nodes] (if any) }`. Children are slot attachments (weapon mods, magazine cartridges, armour plates),
plus grid contents (backpack, rig), slot items first. Names and prices come
from item data, keyed by `tpl`.

## Client → server

### `overlay`
The overlay's configuration (`overlay/Config.hpp`). The frontend sends it in its role of
configuring the overlay; it's for the overlay only, and the backend doesn't use it for anything
else. Only the `type` and `data` fields of the envelope are needed. It's ignored unless `hello`
said `overlay: true`. The latest message wins, from whichever connection. Senders resend after
reconnecting, because a new connection doesn't know what an earlier one sent.
```json
{ "type": "overlay", "data": {
  "on": true, "raid": 3, "delayMs": 20, "grid": false, "lootRange": 150, "scopeRadius": 0.36,
  "otherPlayers": "#e0e0e0",
  "marks": [
    { "kind": "player", "id": 2, "color": "#ff5a52", "label": "Killa", "emphasis": "loud" },
    { "kind": "loot", "id": 40, "color": "#ffd84d", "label": "LEDX", "emphasis": "strong" },
    { "kind": "exfil", "id": 1, "color": "#4cd964", "label": "ZB-1011", "emphasis": "normal" }
  ] } }
```
- **`on`:** draw at all.
- **`raid`:** the raid the marks' ids belong to. Marks for any other raid aren't drawn, because ids
  restart every raid.
- **`marks`:** what to draw, and how. `kind`: `player`, `loot` or `exfil`, with ids as in the
  `players`, `loot` and `exfils` messages. `color`: `#rrggbb` or `#rrggbbaa`. `label`: drawn next
  to the mark, followed by the distance. `emphasis`: `faint`, `normal`, `strong` or `loud` (line
  widths and sizes). Up to 4096 marks; invalid marks are dropped.
- **`otherPlayers`:** colour for living players that aren't among the marks (e.g. spawned since the
  last message); `null`: those aren't drawn.
- **`delayMs`:** draw with the camera as it was this long ago (0–500), so marks keep pace with a
  picture that lags behind the game (Looking Glass, the compositor).
- **`grid`:** dots on the ground around the player, for checking the alignment.
- **`lootRange`:** metres; loot further away isn't drawn.
- **`scopeRadius`:** the scope's picture while scoped: a circle with this radius, as a share of the
  picture's height. Marks inside it are placed through the scope.

## Raid recordings

The backend records every raid to its own file in `recordings/` (`--recordings <dir>`; `--no-record`
turns it off, `--keep-recordings <n>` deletes all but the newest `n`). Recording starts when `status`
becomes `inRaid` and ends when it leaves it (or the raid id changes). The file is named
`<local date>_<time>_<locationId>.jsonl` and gzipped to `.jsonl.gz` once the raid ends.

Format **1** (`kRecordingFormat`): JSON Lines, one message per line, the same envelopes as the
stream, with these differences:

- **The first line is a header:**
  ```json
  { "type": "recording", "raid": 3, "rev": 0, "t": 1794174689050,
    "data": { "protocol": 1, "format": 1, "locationId": "bigmap", "offsetsMismatch": false } }
  ```
- **`players`** is throttled, but written at once when a player appears, dies, leaves or
  disappears. The newest one is always written before the file ends.
- **`loot`** is a keyframe: written at the start and then periodically. Between keyframes,
  changes are written as **`lootDiff`** (only when something changed), relative to the loot as of
  the previous `loot`/`lootDiff` line. `rev` is the loot snapshot's revision.
  ```json
  { "type": "lootDiff", "raid": 3, "rev": 42, "t": ..., "data": {
    "added": [ <loot entries> ], "removed": [ 7, 12 ], "changed": [ <loot entries, complete> ] } }
  ```
- **`skeletons`** is throttled harder than `players` (at most 5 per second); the ones in between are
  dropped. Recordings from before it existed have none.
- **`camera`** is throttled to at most 10 per second, the ones in between dropped.
- `status`, `exfils`, `explosives`, `vehicles`, `equipment` and `quests` are written as sent. The last line is the
  `status` that ended the raid (unless the backend stopped mid-raid).
- A last line may be cut off (a raid in progress, or a crash): readers skip lines that don't parse.

Readers also accept plain message streams without a header (format 0: recordings made with the old
`--record`).

`GET /api/recordings`:
```json
[ { "name": "2026-11-10_19-03-12_bigmap.jsonl.gz", "size": 18234112, "locationId": "bigmap",
    "start": 1794174689050, "end": 1794176489050, "active": false } ]
```
- **`active`:** the raid being recorded right now; its `end` is `null`.
- **`locationId`, `start`, `end`:** `null` when the file doesn't say (empty or unreadable).
