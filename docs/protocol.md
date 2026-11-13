# Backend ↔ frontend protocol

Version **1** (`server/Protocol.hpp` `kProtocolVersion`, `web/src/protocol.ts` `PROTOCOL_VERSION`).
Bump both when a change isn't backwards compatible.

## Transport

`radar-backend` serves HTTP and a WebSocket on one port (default `127.0.0.1:8080`; `--listen` to
change, e.g. `0.0.0.0:8080` for LAN access).

| Route | Content |
|---|---|
| `GET /ws` | WebSocket: the message stream below. Server → client only for now. |
| `GET /maps/index.json` | Generated list of the map folders under `maps/2d` and `maps/3d`: `[{"kind": "2d"\|"3d", "folder": "...", "config": {map.json contents}}]`, sorted by kind, then folder. See `docs/maps.md`, `docs/maps3d.md`. |
| `GET /maps/<kind>/<folder>/<file>` | Map files: 2D layer images, 3D datasets. |
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

On connect, the server sends `hello`, then the **latest message of every type**, so a client
connecting mid-raid gets the full current state at once. After that, messages are sent when the data
changes, at most about 30 times per second.

### `hello`
```json
{ "protocol": 1, "live": true }
```
- **`live`:** false when the backend has no memory source (`--offline`): only recordings to show.

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
  Mapping values to names is the frontend's job (`web/src/roles.ts`). Full players (`local`,
  `client`): `Profile.Info.Settings.Role`. Observed players: `ObservedPlayerView.AIData` →
  `BotHostilityData._role`, which is **unverified** (check with `--diagnose` in a raid) and may only
  appear a few seconds after the player does. Only meaningful for AI: humans carry a default (our own
  PMC reads 1, assault).
- **`nickname`:** the player's nickname (bosses carry their name); omitted if empty.
- **`groupId`:** players spawned together share it (a boss and its guards, a PMC squad); omitted if
  empty.
- **`side`:** `usec`, `bear`, `savage` (scavs, bosses and other non-PMC bots) or `unknown`.
- **`dead`:** permanent once set; the player keeps its last position.
- **`absent`:** left the game's player list without dying (extracted or despawned).
- **`pos`:** world position in metres, Unity axes `[x east, y up, z north]`, centimetre precision.
  `null` until known.
- **`yaw`, `pitch`:** look direction in degrees, as stored by the game. Assumed: yaw 0 = +z (north),
  90 = +x (east). This is unverified; see `docs/verification-playbook.md`.

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
{ "exfils": [ { "id": 1, "kind": "regular", "name": "ZB-1011", "status": 4, "pos": [180.0, 0.0, 150.0] } ] }
```
- **`kind`:** `regular` (only the ones the local player can use) or `secret`.
- **`name`:** the game's internal exit name. Mapping it to a display name is the frontend's job (not
  done yet).
- **`status`:** the game's `EExfiltrationStatus`: 1 closed, 2 requirements not met, 3 countdown,
  4 open, 5 pending, 6 awaiting manual activation.
- **`pos`:** `null` if the position couldn't be read.

### `explosives`
```json
{ "grenades": [ { "id": 2, "pos": [-5.0, 0.5, 20.0] } ],
  "tripwires": [ { "id": 1, "from": [-60.0, 0.2, -10.0], "to": [-52.0, 0.2, -4.0] } ] }
```
Thrown grenades (all types alike) until they explode, and armed tripwires.

### `loot`
```json
{ "loot": [ { "id": 7, "kind": "container", "tpl": "578f8782245977354405a1e3", "obj": "container_safe", "pos": [3.0, 1.0, 3.0] } ] }
```
- **`kind`:** `item`, `quest` (quest item), `container`, `airdrop` or `corpse`.
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
`{ "tpl": template id, "slot": slot id (if in a slot), "count": stack size (if > 1), "items": [child
nodes] (if any) }`. Children are slot attachments (weapon mods, magazine cartridges, armour plates),
plus grid contents (backpack, rig), slot items first. Names and prices come
from item data, keyed by `tpl`.

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
- `status`, `exfils`, `explosives` and `equipment` are written as sent. The last line is the
  `status` that ended the raid (unless the backend stopped mid-raid).
- A last line may be cut off (a raid in progress, or a crash): readers skip lines that don't parse.

Readers also accept plain message streams without a header (format 0: recordings made with the old
`--record`, `tools/make-demo-stream.py` before this format).

`GET /api/recordings`:
```json
[ { "name": "2026-11-10_19-03-12_bigmap.jsonl.gz", "size": 18234112, "locationId": "bigmap",
    "start": 1794174689050, "end": 1794176489050, "active": false } ]
```
- **`active`:** the raid being recorded right now; its `end` is `null`.
- **`locationId`, `start`, `end`:** `null` when the file doesn't say (empty or unreadable).

`tools/make-demo-stream.py` writes a synthetic raid recording for `maps/2d/demo` (`recordings/demo.jsonl`).
