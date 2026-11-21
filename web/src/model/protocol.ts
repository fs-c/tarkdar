// Server → client messages. Mirrors docs/protocol.md.

export const PROTOCOL_VERSION = 1;

export interface Envelope<T extends string, D> {
  type: T;
  raid: number | null;
  rev: number;
  t: number; // ms since the Unix epoch
  data: D;
}

export type AppState = "waitingForProcess" | "waitingForModules" | "waitingForRaid" | "inRaid" | "cooldown";

export interface StatusData {
  state: AppState;
  raidPending: boolean;
  locationId: string | null;
  offsetsMismatch: boolean;
}

export type Side = "usec" | "bear" | "savage" | "unknown";
export type PlayerKind = "local" | "client" | "observed";

/** World coordinates in metres (Unity axes): [x east, y up, z north]. */
export type WorldPos = [number, number, number];

export interface Player {
  id: number;
  local: boolean;
  /** Object layout: "client" = bot simulated on this machine, "observed" = network replica. */
  kind?: PlayerKind;
  ai: boolean;
  side: Side;
  /** Observed players: voice preset (names bot roles and bosses). */
  voice?: string;
  /** The game's role (WildSpawnType), see roles.ts; only meaningful for AI. Observed players' may
   *  appear a moment after the player does. */
  role?: number;
  nickname?: string;
  /** Players spawned together share one (a boss and its guards). Not read online (observed bots). */
  groupId?: string;
  /** Frontend-derived (timeline): AI only, the id of the first bot this one spawned on the same spot
   *  with, at the same time (a boss and its guards, a scav group); unset if it spawned alone. */
  spawnGroup?: number;
  dead: boolean;
  absent: boolean;
  /** Frontend-derived (timeline): absent, not dead, and last seen near an exfil. */
  extracted?: boolean;
  pos: WorldPos | null;
  /** Degrees, as stored by the game. Assumed: 0 = +z (north), 90 = +x (east). */
  yaw: number;
  pitch: number;
  /** Frontend-derived (timeline, from `skeletons`): the body's joints relative to `pos`, in metres,
   *  JOINT_COUNT × [x, y, z] in Joint order. Absent when the skeleton isn't known right now. */
  joints?: ArrayLike<number>;
}

export interface PlayersData {
  players: Player[];
}

/** Body joints, in the order of a skeleton's `j` (docs/protocol.md, `skeletons`). */
export const Joint = {
  base: 0, leftFoot: 1, rightFoot: 2, pelvis: 3, chest: 4, neck: 5, head: 6,
  leftHip: 7, leftKnee: 8, rightHip: 9, rightKnee: 10,
  leftShoulder: 11, leftElbow: 12, leftHand: 13, rightShoulder: 14, rightElbow: 15, rightHand: 16,
} as const;
export const JOINT_COUNT = 17;

export interface SkeletonsData {
  /** `j`: JOINT_COUNT × [x, y, z], whole centimetres relative to the player's position. */
  players: { id: number; j: number[] }[];
}

export interface Exfil {
  id: number;
  kind: "regular" | "secret";
  /** The game's internal exit name (missing in older recordings). */
  key?: string;
  /** Its in-game name, or the internal one if the game has none (older recordings: always internal). */
  name: string;
  /** EExfiltrationStatus: 1 closed, 2 requirements, 3 countdown, 4 open, 5 pending, 6 manual. */
  status: number;
  pos: WorldPos | null;
}

export interface ExplosivesData {
  grenades: { id: number; pos: WorldPos }[];
  tripwires: { id: number; from: WorldPos; to: WorldPos }[];
}

export interface VehicleOccupant {
  /** Player id. */
  player: number;
  /** "gunner": the bot on the BTR's turret; "passenger": getting in, inside or getting out. */
  seat: "gunner" | "passenger";
}

export interface Vehicle {
  id: number;
  kind: "btr";
  /** BTR: 0 stopped, 1 stopped (paid ride), 2 driving. */
  state: number;
  pos: WorldPos;
  /** Heading in degrees, like a player's yaw (0 = +z, 90 = +x). */
  yaw: number;
  occupants: VehicleOccupant[];
}

/** An item and its contents (slot attachments, grid contents). */
export interface ItemNode {
  tpl: string;
  /** Slot id when the item sits in a slot (e.g. "FirstPrimaryWeapon"). */
  slot?: string;
  /** Stack size, when more than 1. */
  count?: number;
  /** Found in raid. */
  fir?: boolean;
  items?: ItemNode[];
}

export interface PlayerEquipment {
  id: number;
  slots: ItemNode[];
}

/** A quest's objective for items, from its template. */
export interface QuestObjective {
  /** The condition id (what `done` lists). */
  id: string;
  type: "find" | "handover" | "plant";
  /** Template ids; any of them counts. */
  items: string[];
  count: number;
  /** Found in raid only (find, hand over). */
  fir?: boolean;
  /** Handed over so far (hand-over objectives with a counter). */
  progress?: number;
  /** English objective text, e.g. "Find the item in raid: Adrenaline injector". */
  text?: string;
}

export type QuestKind = "story" | "side" | "daily" | "weekly";

/** One of the local player's quests in progress (`quests` message). */
export interface QuestState {
  id: string;
  /** EQuestStatus: 2 started, 3 ready to hand in. */
  status: number;
  /** Ids of the conditions (objectives) already completed; null if unreadable. */
  done: string[] | null;
  /** English name; missing for repeatables and most story steps. */
  name?: string;
  /** Trader id (the story's pseudo-trader for story quests). */
  trader?: string;
  kind?: QuestKind;
  /** Not in the quest list (hidden story steps). */
  hidden?: boolean;
  /** Item objectives; null (or missing, in older recordings) when the template couldn't be read. */
  objectives?: QuestObjective[] | null;
}

/** How many of an item the player owns (docs/protocol.md, `stash`): stack units, `fir` of them found in raid. */
export interface OwnedItem {
  tpl: string;
  count: number;
  fir?: number;
}

/** The PMC's items as of the raid's start: the stash (and its other containers), and the profile's
 *  equipment (what the character took in). */
export interface StashData {
  profile: string;
  stash: OwnedItem[];
  equipment: OwnedItem[];
}

export type LootKind = "item" | "quest" | "container" | "airdrop" | "corpse";

export interface LootEntry {
  id: number;
  kind: LootKind;
  /** Item/container template id; empty for airdrops and corpses. */
  tpl: string;
  /** GameObject name, for debugging. */
  obj: string;
  pos: WorldPos;
  /** Corpses: equipment. (Older recordings may have container contents: dropped on parse, see
   *  withoutContainerContents.) */
  contents?: ItemNode[];
}

/** One of the local player's cameras (docs/protocol.md, `camera`). */
export interface CameraView {
  /** View-projection matrix, column-major (element row + 4 × column): world (x, y, z, 1) → clip. */
  vp: number[];
  pos?: WorldPos;
  /** Vertical field of view, degrees. */
  fov?: number;
  /** Width / height. */
  aspect?: number;
}

export interface CameraSight {
  scope: number;
  mode: number;
  zoom: number;
  min?: number;
  max?: number;
  magnified: boolean;
  current: boolean;
}

/** The local player's view: experimental, see docs/protocol.md. */
export interface CameraData {
  fps: CameraView | null;
  aiming: boolean;
  scoped: boolean;
  magnification: number;
  sights: CameraSight[];
  active: number | null;
  optic: CameraView | null;
}

export interface HelloData {
  protocol: number;
  /** False when the backend has no memory source (--offline). Missing from old backends: live. */
  live?: boolean;
  /** The backend runs the overlay (--overlay) and takes `overlay` messages. Missing: it doesn't. */
  overlay?: boolean;
}

export type Message =
  | Envelope<"hello", HelloData>
  | Envelope<"status", StatusData>
  | Envelope<"players", PlayersData>
  | Envelope<"skeletons", SkeletonsData>
  | Envelope<"exfils", { exfils: Exfil[] }>
  | Envelope<"explosives", ExplosivesData>
  | Envelope<"vehicles", { vehicles: Vehicle[] }>
  | Envelope<"loot", { loot: LootEntry[] }>
  | Envelope<"equipment", { players: PlayerEquipment[] }>
  /** `quests` null: not read yet. */
  | Envelope<"quests", { quests: QuestState[] | null }>
  /** `stash` null: not read yet. */
  | Envelope<"stash", { stash: OwnedItem[] | null; profile?: string; equipment?: OwnedItem[] }>
  | Envelope<"camera", CameraData>;

// ---- raid recordings (docs/protocol.md, "Raid recordings") ----

export const RECORDING_FORMAT = 1;

export interface RecordingHeader {
  protocol: number;
  format: number;
  locationId: string;
  offsetsMismatch: boolean;
}

export interface LootDiffData {
  added: LootEntry[];
  removed: number[];
  /** Complete entries. */
  changed: LootEntry[];
}

/** A line of a recording: the stream's messages plus the recording-only ones. */
export type RecordedMessage = Message | Envelope<"recording", RecordingHeader> | Envelope<"lootDiff", LootDiffData>;

/** GET /api/recordings entry. */
export interface RecordingInfo {
  name: string;
  size: number;
  locationId: string | null;
  start: number | null;
  /** Null while it's being recorded. */
  end: number | null;
  active: boolean;
}

/** The game sometimes parks some despawned/uninitialised entities at about -9999 on some axis; the backend sends it as is. */
export const isSentinelPos = (pos: readonly number[] | null | undefined): boolean => !!pos && pos.some((c) => c <= -9000);

/** A `stash` message's data as StashData; null when not read yet. */
export function stashData(d: { stash: OwnedItem[] | null; profile?: string; equipment?: OwnedItem[] }): StashData | null {
  return Array.isArray(d.stash) ? { profile: d.profile ?? "", stash: d.stash, equipment: d.equipment ?? [] } : null;
}

export function parseMessage(text: string): Message | null {
  try {
    const m = JSON.parse(text) as { type?: unknown };
    if (typeof m !== "object" || m === null || typeof m.type !== "string") return null;
    return withoutContainerContents(m as Message);
  } catch {
    return null;
  }
}

/** Container contents can't be read reliably; only corpses (equipment) keep `contents`. Older
 *  backends sent them for containers too, and recordings still have them. Changes `m` in place
 *  (and returns it). */
export function withoutContainerContents<M extends RecordedMessage>(m: M): M {
  const strip = (l: LootEntry): LootEntry => {
    if (l.kind === "corpse" || !l.contents) return l;
    const { contents: _, ...rest } = l;
    return rest;
  };
  const msg = m as RecordedMessage;
  if (msg.type === "loot" && Array.isArray(msg.data?.loot)) msg.data.loot = msg.data.loot.map(strip);
  if (msg.type === "lootDiff" && msg.data) {
    if (Array.isArray(msg.data.added)) msg.data.added = msg.data.added.map(strip);
    if (Array.isArray(msg.data.changed)) msg.data.changed = msg.data.changed.map(strip);
  }
  return m;
}

// ---- Client → server ----

/** A thing for the overlay to mark: which one (as in this raid's messages) and how. */
export interface OverlayMark {
  kind: "player" | "loot" | "exfil";
  id: number;
  /** "#rrggbb" or "#rrggbbaa" */
  color: string;
  label: string;
  emphasis: "faint" | "normal" | "strong" | "loud";
}

/** The overlay's configuration (docs/protocol.md, `overlay`): for the overlay only. */
export interface OverlayData {
  on: boolean;
  /** The raid the marks' ids belong to. */
  raid: number | null;
  delayMs: number;
  grid: boolean;
  lootRange: number;
  scopeRadius: number;
  /** Players not among the marks are drawn in this colour; null: not drawn. */
  otherPlayers: string | null;
  marks: OverlayMark[];
}

export type ClientMessage = { type: "overlay"; data: OverlayData };
