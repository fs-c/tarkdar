# Backend ↔ frontend protocol

Version **1** (`server/Protocol.hpp` `kProtocolVersion`, `web/src/protocol.ts` `PROTOCOL_VERSION`).
Bump both when a change isn't backwards compatible.

## Transport

`radar-backend` serves HTTP and a WebSocket on one port (default `127.0.0.1:8080`; `--listen` to
change, e.g. `0.0.0.0:8080` for LAN access).

| Route | Content |
|---|---|
| `GET /ws` | WebSocket: the message stream below. Server → client only for now. |
| `GET /maps/index.json` | Generated list of map folders: `[{"folder": "...", "config": {map.json contents}}]`, sorted by folder. See `docs/maps.md`. |
| `GET /maps/<folder>/<file>` | Map images. |
| `GET /data/<path>` | Item/quest data files (not used yet). |
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
{ "protocol": 1 }
```

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
- **`side`:** `usec`, `bear`, `savage` (scavs, bosses and other non-PMC bots) or `unknown`.
- **`dead`:** permanent once set; the player keeps its last position.
- **`absent`:** left the game's player list without dying (extracted or despawned).
- **`pos`:** world position in metres, Unity axes `[x east, y up, z north]`, centimetre precision.
  `null` until known.
- **`yaw`, `pitch`:** look direction in degrees, as stored by the game. Assumed: yaw 0 = +z (north),
  90 = +x (east). This is unverified; see `docs/verification-playbook.md`.

The whole list is sent on every change (players are few; positions change every tick anyway).

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
- **`contents`** (optional): for containers, their contents; for corpses, their equipment. A list of
  item nodes (below).

Sent after every loot scan or resolve that changed something (a few thousand entries at most).

### `equipment`
```json
{ "players": [ { "id": 4, "slots": [
  { "tpl": "5bb2475ed4351e00853264e3", "slot": "FirstPrimaryWeapon", "items": [
    { "tpl": "55d4887d4bdc2d962f8b4570", "slot": "mod_magazine", "items": [
      { "tpl": "54527a984bdc2d4e668b4567", "slot": "cartridges", "count": 30 } ] } ] } ] } ] }
```
Equipment per player id (players without readable equipment are omitted). Each player is re-read at
most every 5 s, and the message is sent when something changed.

### Item nodes
`{ "tpl": template id, "slot": slot id (if in a slot), "count": stack size (if > 1), "items": [child
nodes] (if any) }`. Children are slot attachments (weapon mods, magazine cartridges, armour plates),
plus grid contents (backpack, rig, container) once the grid offsets are known. Names and prices come
from item data, keyed by `tpl`.

## Recording and replay

- `radar-backend --record stream.jsonl` appends every message to a file (JSON Lines, one message per
  line), live or in replay.
- `radar-backend --replay stream.jsonl` serves a recording instead of a live game, timed by the `t`
  fields. Options: `--replay-speed 2` and `--replay-once`; it loops by default.
- `tools/make-demo-stream.py` generates a synthetic raid for `maps/demo`.
