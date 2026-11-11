// A raid's history: everything a recording (or the live stream) said, indexed by time, so the radar
// can show any moment of it, draw where players have been and list what happened.
//
// Built by ingesting messages in time order (a recording's lines, then live messages). Per type,
// messages with a revision already seen are dropped, so a recording and the live stream that
// overlaps it can be fed in one after the other.

import { isSentinelPos } from "./connection";
import type {
  Exfil,
  ExplosivesData,
  LootDiffData,
  LootEntry,
  Player,
  PlayerEquipment,
  RecordedMessage,
  StatusData,
  WorldPos,
} from "./protocol";

/** The parts of RadarState a timeline provides for a moment. */
export interface TimelineState {
  status: StatusData | null;
  raid: number | null;
  players: Player[];
  playersAt: number;
  exfils: Exfil[];
  explosives: ExplosivesData;
  loot: LootEntry[];
  equipment: Map<number, PlayerEquipment>;
}

export type TimelineEvent =
  | { t: number; kind: "playerSeen"; player: number }
  | { t: number; kind: "died"; player: number; pos: WorldPos | null }
  | { t: number; kind: "left"; player: number; pos: WorldPos | null }
  | { t: number; kind: "extracted"; player: number; pos: WorldPos | null }
  | { t: number; kind: "lootAdded"; loot: LootEntry }
  | { t: number; kind: "lootRemoved"; loot: LootEntry }
  | { t: number; kind: "lootChanged"; loot: LootEntry; before: LootEntry }
  | { t: number; kind: "exfilStatus"; exfil: number; from: number; to: number };

export type EventKind = TimelineEvent["kind"];

/** A player's positions over time (only samples with a position, only when something moved). */
export class Track {
  n = 0;
  t = new Float64Array(64);
  x = new Float32Array(64);
  y = new Float32Array(64);
  z = new Float32Array(64);
  yaw = new Float32Array(64);
  pitch = new Float32Array(64);
  /** dead/absent changes, in time order; the first entry is when the player was first seen. */
  readonly flags: { t: number; dead: boolean; absent: boolean; extracted: boolean }[] = [];

  /** Sample indices for drawing trails: thinned to one per TRAIL_STEP_M of movement (built lazily). */
  private readonly kept: number[] = [];
  private keptUpTo = 0;

  /** Latest non-positional fields (side, voice, role, … can be resolved late). */
  constructor(public meta: Player) {}

  /** Indices of the samples a trail is drawn through (oldest first). */
  trailIndices(): readonly number[] {
    for (; this.keptUpTo < this.n; this.keptUpTo++) {
      const i = this.keptUpTo;
      const last = this.kept.at(-1);
      if (
        last === undefined ||
        Math.hypot(this.x[i]! - this.x[last]!, this.z[i]! - this.z[last]!) >= TRAIL_STEP_M ||
        Math.abs(this.y[i]! - this.y[last]!) >= TRAIL_STEP_M
      )
        this.kept.push(i);
    }
    return this.kept;
  }

  /** Horizontal distance travelled up to time t (m). */
  distanceUntil(t: number): number {
    const end = this.indexAt(t);
    let d = 0;
    for (let i = 1; i <= end; i++) d += Math.hypot(this.x[i]! - this.x[i - 1]!, this.z[i]! - this.z[i - 1]!);
    return d;
  }

  get firstSeen(): number {
    return this.flags[0]?.t ?? Infinity;
  }

  push(t: number, p: Player): void {
    if (!p.pos) return;
    const i = this.n - 1;
    if (i >= 0 && this.x[i] === p.pos[0] && this.y[i] === p.pos[1] && this.z[i] === p.pos[2] && this.yaw[i] === p.yaw && this.pitch[i] === p.pitch)
      return;
    if (this.n === this.t.length) this.grow();
    const j = this.n++;
    this.t[j] = i >= 0 ? Math.max(t, this.t[i]!) : t;
    this.x[j] = p.pos[0];
    this.y[j] = p.pos[1];
    this.z[j] = p.pos[2];
    this.yaw[j] = p.yaw;
    this.pitch[j] = p.pitch;
  }

  /** The last recorded position, if any. */
  lastPos(): WorldPos | null {
    return this.n ? this.posOf(this.n - 1) : null;
  }

  /** Time of sample i. */
  timeOf(i: number): number {
    return this.t[i]!;
  }

  /** Position of sample i. */
  posOf(i: number): WorldPos {
    return [this.x[i]!, this.y[i]!, this.z[i]!];
  }

  /** Index of the last sample at or before t, or -1. */
  indexAt(t: number): number {
    let lo = 0, hi = this.n - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.t[mid]! <= t) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found;
  }

  flagsAt(t: number): { dead: boolean; absent: boolean; extracted: boolean } | null {
    let found: (typeof this.flags)[number] | null = null;
    for (const f of this.flags) {
      if (f.t > t) break;
      found = f;
    }
    return found;
  }

  /** Position and look direction at t: interpolated between close samples, else the last one. */
  poseAt(t: number): { pos: WorldPos; yaw: number; pitch: number } | null {
    const i = this.indexAt(t);
    if (i < 0) return null;
    const j = i + 1;
    const ti = this.t[i]!;
    if (j < this.n) {
      const tj = this.t[j]!;
      if (tj > ti && tj - ti <= MAX_INTERPOLATION_GAP_MS) {
        const k = (t - ti) / (tj - ti);
        const lerp = (a: Float32Array<ArrayBuffer>) => a[i]! + (a[j]! - a[i]!) * k;
        return {
          pos: [round2(lerp(this.x)), round2(lerp(this.y)), round2(lerp(this.z))],
          yaw: lerpAngle(this.yaw[i]!, this.yaw[j]!, k),
          pitch: lerp(this.pitch),
        };
      }
    }
    return { pos: this.posOf(i), yaw: this.yaw[i]!, pitch: this.pitch[i]! };
  }

  private grow(): void {
    const size = this.t.length * 2;
    const f32 = (a: Float32Array<ArrayBuffer>) => copy(new Float32Array(size), a);
    this.t = copy(new Float64Array(size), this.t);
    this.x = f32(this.x);
    this.y = f32(this.y);
    this.z = f32(this.z);
    this.yaw = f32(this.yaw);
    this.pitch = f32(this.pitch);
  }
}

/** A player that left this close (m, horizontally) to an exfil counts as extracted. */
const EXTRACT_RADIUS_M = 50;

function nearExfil(pos: WorldPos | null, exfils: Exfil[]): boolean {
  if (!pos) return false;
  return exfils.some((e) => e.pos && !isSentinelPos(e.pos) && Math.hypot(e.pos[0] - pos[0], e.pos[2] - pos[2]) <= EXTRACT_RADIUS_M);
}

/** Trails keep a point per this much movement (m). */
const TRAIL_STEP_M = 1;
/** Samples further apart than this aren't interpolated (the player stood still in between). */
const MAX_INTERPOLATION_GAP_MS = 500;
/** Live loot (full lists) is stored as a keyframe this often, as diffs in between. */
const LOOT_KEYFRAME_MS = 60_000;

type Stamped<T> = { t: number; value: T };
type LootVersion = { t: number; key: LootEntry[] } | { t: number; diff: LootDiffData };

const EMPTY_EXPLOSIVES: ExplosivesData = { grenades: [], tripwires: [] };
const EMPTY_EQUIPMENT = new Map<number, PlayerEquipment>();

export class Timeline {
  /** From the recording header, else the first in-raid status. */
  locationId: string | null = null;
  raid: number | null = null;
  /** Time of the first and last message (ms since the epoch); NaN while empty. */
  start = NaN;
  end = NaN;
  /** Bumped on every change, so React can tell. */
  version = 0;

  readonly tracks = new Map<number, Track>();
  readonly events: TimelineEvent[] = [];

  private readonly revs = new Map<string, number>();
  private readonly statuses: Stamped<StatusData>[] = [];
  private readonly exfils: Stamped<Exfil[]>[] = [];
  private readonly explosives: Stamped<ExplosivesData>[] = [];
  private readonly equipment: Stamped<Map<number, PlayerEquipment>>[] = [];
  private readonly loot: LootVersion[] = [];
  /** The loot as of the last version. */
  private lootHead = new Map<number, LootEntry>();
  private lootCache: { index: number; entries: LootEntry[] } = { index: -1, entries: [] };
  /** Player order: by id, as the backend sends them. */
  private playerIds: number[] = [];

  /** Takes one message; returns whether it changed anything. */
  ingest(msg: RecordedMessage): boolean {
    if (typeof msg.t !== "number") return false;
    if (msg.type === "hello") return false;
    if (msg.type === "recording") {
      this.locationId = msg.data.locationId;
      this.raid = msg.raid;
      this.stamp(msg.t);
      return true;
    }
    if (msg.type !== "status") {
      // lootDiff and loot share the loot snapshot's revision.
      const revKey = msg.type === "lootDiff" ? "loot" : msg.type;
      const seen = this.revs.get(revKey);
      if (seen !== undefined && msg.rev <= seen) return false;
      this.revs.set(revKey, msg.rev);
    } else {
      // Status revisions are attach generations, not changes: go by time.
      const last = this.statuses.at(-1);
      if (last && msg.t < last.t) return false;
    }
    const t = Math.max(msg.t, Number.isNaN(this.end) ? msg.t : this.end);
    this.stamp(t);
    switch (msg.type) {
      case "status":
        this.statuses.push({ t, value: msg.data });
        if (msg.data.state === "inRaid") {
          this.locationId ??= msg.data.locationId;
          this.raid ??= msg.raid;
        }
        break;
      case "players":
        this.ingestPlayers(t, msg.data.players);
        break;
      case "exfils":
        this.ingestExfils(t, msg.data.exfils);
        break;
      case "explosives":
        this.explosives.push({ t, value: msg.data });
        break;
      case "equipment":
        this.equipment.push({ t, value: new Map(msg.data.players.map((p) => [p.id, p])) });
        break;
      case "loot":
        this.ingestLoot(t, msg.data.loot);
        break;
      case "lootDiff":
        this.applyLootDiff(t, msg.data);
        break;
    }
    this.version++;
    return true;
  }

  private stamp(t: number): void {
    if (Number.isNaN(this.start)) this.start = t;
    this.end = Number.isNaN(this.end) ? t : Math.max(this.end, t);
  }

  private ingestPlayers(t: number, players: Player[]): void {
    let added = false;
    const exits = this.exfils.at(-1)?.value ?? [];
    for (const p of players) {
      let track = this.tracks.get(p.id);
      if (!track) {
        track = new Track(p);
        this.tracks.set(p.id, track);
        added = true;
        this.events.push({ t, kind: "playerSeen", player: p.id });
      }
      track.meta = p;
      // Parked at about -9999 (despawned): gone, whatever the list says; keep the last real position.
      const parked = isSentinelPos(p.pos);
      const absent = p.absent || parked;
      const last = track.flags.at(-1);
      if (!last || last.dead !== p.dead || last.absent !== absent) {
        const lastPos = parked || !p.pos ? track.lastPos() : p.pos;
        // Left (not dead) close to an exit: extracted. Anything else that left is just "left".
        const extracted = absent && !p.dead && nearExfil(lastPos, exits);
        track.flags.push({ t, dead: p.dead, absent, extracted });
        if (last && p.dead && !last.dead) this.events.push({ t, kind: "died", player: p.id, pos: p.pos });
        else if (last && absent && !last.absent && !p.dead) this.events.push({ t, kind: extracted ? "extracted" : "left", player: p.id, pos: lastPos });
      }
      if (!parked) track.push(t, p);
    }
    if (added) this.playerIds = [...this.tracks.keys()].sort((a, b) => a - b);
  }

  private ingestExfils(t: number, exfils: Exfil[]): void {
    const before = this.exfils.at(-1)?.value;
    if (before) {
      const old = new Map(before.map((e) => [e.id, e.status]));
      for (const e of exfils) {
        const from = old.get(e.id);
        if (from !== undefined && from !== e.status) this.events.push({ t, kind: "exfilStatus", exfil: e.id, from, to: e.status });
      }
    }
    this.exfils.push({ t, value: exfils });
  }

  /** A full loot list: a keyframe now and then, otherwise stored as the diff to the previous one. */
  private ingestLoot(t: number, entries: LootEntry[]): void {
    const lastKey = this.lastLootKeyframe();
    if (this.loot.length === 0 || lastKey === null || t - lastKey >= LOOT_KEYFRAME_MS) {
      this.lootEvents(t, diffLoot(this.lootHead, entries));
      this.loot.push({ t, key: entries });
      this.lootHead = new Map(entries.map((l) => [l.id, l]));
      return;
    }
    this.applyLootDiff(t, diffLoot(this.lootHead, entries));
  }

  private applyLootDiff(t: number, diff: LootDiffData): void {
    this.lootEvents(t, diff);
    for (const id of diff.removed) this.lootHead.delete(id);
    for (const l of diff.added) this.lootHead.set(l.id, l);
    for (const l of diff.changed) this.lootHead.set(l.id, l);
    this.loot.push({ t, diff });
  }

  private lootEvents(t: number, diff: LootDiffData): void {
    // The first loot is the raid's starting state, not something that happened.
    const initial = this.loot.length === 0;
    if (!initial) for (const l of diff.added) this.events.push({ t, kind: "lootAdded", loot: l });
    for (const id of diff.removed) {
      const l = this.lootHead.get(id);
      if (l) this.events.push({ t, kind: "lootRemoved", loot: l });
    }
    // Only contents changes are events: positions shift (falling airdrops, physics) without anything happening.
    for (const l of diff.changed) {
      const before = this.lootHead.get(l.id);
      if (before && !sameContents(before, l)) this.events.push({ t, kind: "lootChanged", loot: l, before });
    }
  }

  private lastLootKeyframe(): number | null {
    for (let i = this.loot.length - 1; i >= 0; i--) {
      const v = this.loot[i]!;
      if ("key" in v) return v.t;
    }
    return null;
  }

  /** The players as they were at time t. */
  playersAtTime(t: number): { players: Player[]; playersAt: number } {
    const players: Player[] = [];
    let playersAt = 0;
    for (const id of this.playerIds) {
      const track = this.tracks.get(id)!;
      const flags = track.flagsAt(t);
      if (!flags) continue; // not seen yet
      const pose = track.poseAt(t);
      if (pose) playersAt = Math.max(playersAt, Math.min(t, track.timeOf(track.n - 1)));
      players.push({ ...track.meta, dead: flags.dead, absent: flags.absent, extracted: flags.extracted, pos: pose?.pos ?? null, yaw: pose?.yaw ?? 0, pitch: pose?.pitch ?? 0 });
    }
    return { players, playersAt };
  }

  /** The raid as it was at time t. Unchanged parts keep their identity between calls. */
  stateAt(t: number): TimelineState {
    const { players, playersAt } = this.playersAtTime(t);
    const status = latest(this.statuses, t);
    return {
      status,
      raid: status?.state === "inRaid" ? this.raid : null,
      players,
      playersAt,
      exfils: latest(this.exfils, t) ?? [],
      explosives: latest(this.explosives, t) ?? EMPTY_EXPLOSIVES,
      loot: this.lootAt(t),
      equipment: latest(this.equipment, t) ?? EMPTY_EQUIPMENT,
    };
  }

  private lootAt(t: number): LootEntry[] {
    const index = lastIndexAt(this.loot, t);
    if (index === this.lootCache.index) return this.lootCache.entries;
    let entries: LootEntry[] = [];
    if (index >= 0) {
      let k = index;
      while (k > 0 && !("key" in this.loot[k]!)) k--;
      const first = this.loot[k]!;
      const map = new Map<number, LootEntry>("key" in first ? first.key.map((l) => [l.id, l]) : []);
      if (!("key" in first)) {
        // No keyframe (a recording that starts with diffs): the first version applies like the rest.
        for (const l of first.diff.added) map.set(l.id, l);
        for (const l of first.diff.changed) map.set(l.id, l);
      }
      for (let i = k + 1; i <= index; i++) {
        const v = this.loot[i]!;
        if ("key" in v) continue;
        for (const id of v.diff.removed) map.delete(id);
        for (const l of v.diff.added) map.set(l.id, l);
        for (const l of v.diff.changed) map.set(l.id, l);
      }
      entries = [...map.values()];
    }
    this.lootCache = { index, entries };
    return entries;
  }

  /** The part worth showing: from the first in-raid status until just before the raid ended. */
  range(): [number, number] {
    const first = this.statuses.findIndex((s) => s.value.state === "inRaid");
    if (first < 0) return [this.start, this.end];
    const ended = this.statuses.slice(first).find((s) => s.value.state !== "inRaid");
    const from = this.statuses[first]!.t;
    return [from, ended ? Math.max(from, ended.t - 1) : this.end];
  }

  /** Events in [from, to], oldest first. */
  eventsBetween(from: number, to: number): TimelineEvent[] {
    return this.events.filter((e) => e.t >= from && e.t <= to);
  }
}

/** Changes from `before` to the full list `after`. */
export function diffLoot(before: Map<number, LootEntry>, after: LootEntry[]): LootDiffData {
  const added: LootEntry[] = [], changed: LootEntry[] = [];
  const gone = new Set(before.keys());
  for (const l of after) {
    const old = before.get(l.id);
    gone.delete(l.id);
    if (!old) added.push(l);
    else if (old !== l && !sameLoot(old, l)) changed.push(l);
  }
  return { added, removed: [...gone], changed };
}

function sameLoot(a: LootEntry, b: LootEntry): boolean {
  return (
    a.kind === b.kind && a.tpl === b.tpl && a.obj === b.obj && a.pos[0] === b.pos[0] && a.pos[1] === b.pos[1] && a.pos[2] === b.pos[2] &&
    sameContents(a, b)
  );
}

function sameContents(a: LootEntry, b: LootEntry): boolean {
  return a.contents === b.contents || JSON.stringify(a.contents ?? null) === JSON.stringify(b.contents ?? null);
}

function lastIndexAt(list: { t: number }[], t: number): number {
  let lo = 0, hi = list.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]!.t <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

function latest<T>(list: Stamped<T>[], t: number): T | null {
  const i = lastIndexAt(list, t);
  return i >= 0 ? list[i]!.value : null;
}

function copy<A extends Float32Array<ArrayBuffer> | Float64Array<ArrayBuffer>>(to: A, from: A): A {
  to.set(from);
  return to;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Degrees, the short way round. */
function lerpAngle(a: number, b: number, k: number): number {
  const d = ((((b - a) % 360) + 540) % 360) - 180;
  return (a + d * k + 360) % 360;
}
