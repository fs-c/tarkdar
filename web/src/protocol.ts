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
  /** Players spawned together share one (a boss and its guards). */
  groupId?: string;
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
  /** The game's internal exit name. */
  name: string;
  /** EExfiltrationStatus: 1 closed, 2 requirements, 3 countdown, 4 open, 5 pending, 6 manual. */
  status: number;
  pos: WorldPos | null;
}

export interface ExplosivesData {
  grenades: { id: number; pos: WorldPos }[];
  tripwires: { id: number; from: WorldPos; to: WorldPos }[];
}

/** An item and its contents (slot attachments, grid contents). */
export interface ItemNode {
  tpl: string;
  /** Slot id when the item sits in a slot (e.g. "FirstPrimaryWeapon"). */
  slot?: string;
  /** Stack size, when more than 1. */
  count?: number;
  items?: ItemNode[];
}

export interface PlayerEquipment {
  id: number;
  slots: ItemNode[];
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
  /** Containers: contents. Corpses: equipment. */
  contents?: ItemNode[];
}

export interface HelloData {
  protocol: number;
  /** False when the backend has no memory source (--offline). Missing from old backends: live. */
  live?: boolean;
}

export type Message =
  | Envelope<"hello", HelloData>
  | Envelope<"status", StatusData>
  | Envelope<"players", PlayersData>
  | Envelope<"skeletons", SkeletonsData>
  | Envelope<"exfils", { exfils: Exfil[] }>
  | Envelope<"explosives", ExplosivesData>
  | Envelope<"loot", { loot: LootEntry[] }>
  | Envelope<"equipment", { players: PlayerEquipment[] }>;

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

export function parseMessage(text: string): Message | null {
  try {
    const m = JSON.parse(text) as { type?: unknown };
    if (typeof m !== "object" || m === null || typeof m.type !== "string") return null;
    return m as Message;
  } catch {
    return null;
  }
}
