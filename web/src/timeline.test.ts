import { LiveTimeline } from "./liveTimeline";
import type { LootEntry, Message, Player, RecordedMessage, StatusData } from "./protocol";
import { ingestLines } from "./recordings";
import { Timeline, diffLoot } from "./timeline";

const T0 = 1_000_000;

function env<T extends RecordedMessage["type"]>(type: T, t: number, rev: number, data: unknown, raid: number | null = 1): RecordedMessage {
  return { type, raid, rev, t, data } as RecordedMessage;
}

const status = (t: number, state: StatusData["state"], raid: number | null = 1): RecordedMessage =>
  env("status", t, 1, { state, raidPending: false, locationId: state === "inRaid" ? "bigmap" : null, offsetsMismatch: false }, raid);

const player = (id: number, x: number, extra: Partial<Player> = {}): Player => ({
  id, local: id === 1, ai: id !== 1, side: "usec", dead: false, absent: false, pos: [x, 0, 0], yaw: 0, pitch: 0, ...extra,
});

const players = (t: number, rev: number, list: Player[]) => env("players", t, rev, { players: list });
const loot = (id: number, tpl = "x"): LootEntry => ({ id, kind: "item", tpl, obj: "o", pos: [id, 0, 0] });

describe("Timeline", () => {
  it("tracks players, interpolating between close samples", () => {
    const tl = new Timeline();
    tl.ingest(status(T0, "inRaid"));
    tl.ingest(players(T0 + 100, 1, [player(1, 0)]));
    tl.ingest(players(T0 + 200, 2, [player(1, 10), player(2, 5)]));
    tl.ingest(players(T0 + 5000, 3, [player(1, 20), player(2, 5, { dead: true })]));

    expect(tl.stateAt(T0 + 50).players).toEqual([]); // nobody seen yet
    expect(tl.stateAt(T0 + 150).players.map((p) => p.pos)).toEqual([[5, 0, 0]]);
    // Far-apart samples: held, not interpolated.
    expect(tl.stateAt(T0 + 2600).players.find((p) => p.id === 1)?.pos).toEqual([10, 0, 0]);
    const end = tl.stateAt(T0 + 5000).players;
    expect(end.find((p) => p.id === 2)).toMatchObject({ dead: true, pos: [5, 0, 0] });
    expect(tl.stateAt(T0 + 4999).players.find((p) => p.id === 2)?.dead).toBe(false);

    expect(tl.events.map((e) => e.kind)).toEqual(["playerSeen", "playerSeen", "died"]);
    expect(tl.events[2]).toMatchObject({ t: T0 + 5000, player: 2 });
  });

  it("drops messages it has seen (by revision) and keeps time monotonic", () => {
    const tl = new Timeline();
    expect(tl.ingest(players(T0, 5, [player(1, 0)]))).toBe(true);
    expect(tl.ingest(players(T0 + 10, 5, [player(1, 99)]))).toBe(false);
    expect(tl.ingest(players(T0 + 5, 4, [player(1, 99)]))).toBe(false);
    expect(tl.ingest(players(T0 - 100, 6, [player(1, 1)]))).toBe(true); // older time: clamped
    expect(tl.end).toBe(T0);
    expect(tl.stateAt(T0).players[0]?.pos).toEqual([1, 0, 0]);
  });

  it("rebuilds loot at any time, from full lists and from diffs", () => {
    const tl = new Timeline();
    tl.ingest(env("loot", T0, 1, { loot: [loot(1), loot(2)] }));
    tl.ingest(env("loot", T0 + 1000, 2, { loot: [loot(2), loot(3)] })); // full list: stored as a diff
    tl.ingest(env("lootDiff", T0 + 2000, 3, { added: [], removed: [2], changed: [{ ...loot(3, "y"), contents: [{ tpl: "c" }] }] }));
    tl.ingest(env("lootDiff", T0 + 2100, 4, { added: [], removed: [], changed: [{ ...loot(3, "y"), contents: [{ tpl: "c" }], pos: [9, 9, 9] }] }));

    const ids = (t: number) => tl.stateAt(t).loot.map((l) => `${l.id}${l.tpl}`);
    expect(ids(T0)).toEqual(["1x", "2x"]);
    expect(ids(T0 + 1500)).toEqual(["2x", "3x"]);
    expect(ids(T0 + 2500)).toEqual(["3y"]);
    // Same version: same array, so list rows don't rebuild.
    expect(tl.stateAt(T0 + 2600).loot).toBe(tl.stateAt(T0 + 2700).loot);
    expect(tl.stateAt(T0 + 2600).loot[0]?.pos).toEqual([9, 9, 9]); // moved: in the state, but no event

    // The starting loot isn't an event; what happened after is.
    expect(tl.events.map((e) => `${e.kind}:${"loot" in e ? e.loot.id : ""}`)).toEqual([
      "lootAdded:3", "lootRemoved:1", "lootRemoved:2", "lootChanged:3",
    ]);
  });

  it("diffLoot", () => {
    const before = new Map([1, 2, 3].map((id) => [id, loot(id)]));
    const d = diffLoot(before, [loot(1), loot(3, "z"), loot(4)]);
    expect(d.added.map((l) => l.id)).toEqual([4]);
    expect(d.removed).toEqual([2]);
    expect(d.changed.map((l) => l.id)).toEqual([3]);
  });

  it("range: the raid, without what came after it", () => {
    const tl = new Timeline();
    tl.ingest(env("recording", T0, 0, { protocol: 1, format: 1, locationId: "woods", offsetsMismatch: false }, 7));
    tl.ingest(status(T0 + 10, "inRaid", 7));
    tl.ingest(players(T0 + 500, 1, [player(1, 0)]));
    tl.ingest(status(T0 + 900, "cooldown", null));
    expect(tl.locationId).toBe("woods");
    expect(tl.raid).toBe(7);
    expect(tl.range()).toEqual([T0 + 10, T0 + 899]);
    expect(tl.stateAt(T0 + 899).status?.state).toBe("inRaid");
  });

  it("ingests recording lines, skipping broken ones", () => {
    const tl = new Timeline();
    ingestLines(tl, [JSON.stringify(status(T0, "inRaid")), "garbage", JSON.stringify(players(T0 + 1, 1, [player(1, 3)])), '{"type":"pla']);
    expect(tl.stateAt(T0 + 1).players).toHaveLength(1);
  });
});

describe("LiveTimeline", () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("starts with a raid's status, including snapshots sent before it", () => {
    const live = new LiveTimeline(null);
    live.handle(players(T0, 1, [player(1, 0)]) as Message); // hub order: snapshots before status
    live.handle(status(T0, "inRaid") as Message);
    expect(live.timeline?.stateAt(T0).players).toHaveLength(1);
    live.handle(status(T0 + 100, "cooldown", null) as Message);
    expect(live.timeline).toBeNull();
  });

  it("fills in the raid so far from its recording, then keeps the live messages", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const live = new LiveTimeline({
      active: async () => ({ name: "r.jsonl", size: 0, locationId: "bigmap", start: T0, end: null, active: true }),
      read: async (_name, into) => {
        await gate;
        into.ingest(env("recording", T0 - 1000, 0, { protocol: 1, format: 1, locationId: "bigmap", offsetsMismatch: false }));
        into.ingest(status(T0 - 1000, "inRaid"));
        into.ingest(players(T0 - 900, 1, [player(1, 0)]));
        into.ingest(players(T0 - 100, 9, [player(1, 8)]));
        into.ingest(players(T0, 10, [player(1, 9)]));
      },
    });
    live.handle(status(T0, "inRaid") as Message);
    live.handle(players(T0, 10, [player(1, 9)]) as Message); // also in the recording
    live.handle(players(T0 + 100, 11, [player(1, 10)]) as Message); // live only
    expect(live.backfilling).toBe(true);
    expect(live.timeline?.start).toBe(T0);

    release();
    await flush();
    await flush();
    expect(live.backfilling).toBe(false);
    const tl = live.timeline!;
    expect(tl.start).toBe(T0 - 1000);
    expect(tl.stateAt(T0 - 900).players[0]?.pos).toEqual([0, 0, 0]);
    expect(tl.stateAt(T0 + 100).players[0]?.pos).toEqual([10, 0, 0]);
    // Messages after the swap go to the new timeline.
    live.handle(players(T0 + 200, 12, [player(1, 11)]) as Message);
    expect(tl.stateAt(T0 + 200).players[0]?.pos).toEqual([11, 0, 0]);
  });

  it("ignores another raid's recording", async () => {
    const live = new LiveTimeline({
      active: async () => ({ name: "old.jsonl", size: 0, locationId: "x", start: 0, end: null, active: true }),
      read: async (_name, into) => void into.ingest(status(T0 - 5000, "inRaid", 3)),
    });
    live.handle(status(T0, "inRaid", 4) as Message);
    await flush();
    await flush();
    expect(live.timeline?.start).toBe(T0);
  });
});
