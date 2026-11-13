import { contentsDelta, describeEvent, eventConcerns, eventGroup, playerName } from "./events";
import { type ItemCatalog, type ItemInfo, emptyCatalog } from "./items";
import type { LootEntry, Player, RecordedMessage } from "./protocol";
import { Timeline, isJump } from "./timeline";

const catalog: ItemCatalog = {
  ...emptyCatalog,
  lookup: (tpl) => (({ a: { shortName: "LEDX" }, b: { shortName: "M4A1" }, c: { shortName: "PACA" } }) as Record<string, Partial<ItemInfo>>)[tpl] as ItemInfo | undefined,
};

const base: Player = { id: 2, local: false, ai: true, side: "savage", dead: false, absent: false, pos: [0, 0, 0], yaw: 0, pitch: 0 };

describe("events", () => {
  it("names players", () => {
    expect(playerName({ ...base, local: true }, 1)).toBe("You");
    expect(playerName({ ...base, voice: "Scav_1" }, 2)).toBe("Scav #2");
    expect(playerName({ ...base, role: 6 }, 3)).toMatch(/Killa #3/);
    expect(playerName({ ...base, side: "usec", ai: false }, 4)).toBe("USEC #4");
    expect(playerName({ ...base, side: "bear" }, 5)).toBe("BEAR bot #5");
    expect(playerName(undefined, 9)).toBe("#9");
  });

  it("contentsDelta counts by template, nested too", () => {
    const d = contentsDelta(
      [{ tpl: "b", items: [{ tpl: "a" }] }, { tpl: "c" }, { tpl: "c" }],
      [{ tpl: "c" }, { tpl: "x" }],
      catalog,
    );
    expect(d.removed).toEqual(["M4A1", "LEDX", "PACA"]);
    expect(d.added).toEqual(["x"]);
  });

  it("describes loot events, showing removals just before", () => {
    const tl = new Timeline();
    const corpse = (contents: LootEntry["contents"]): LootEntry => ({ id: 5, kind: "corpse", tpl: "", obj: "", pos: [1, 2, 3], contents });
    const item: LootEntry = { id: 6, kind: "item", tpl: "a", obj: "", pos: [4, 5, 6] };
    const msg = (t: number, rev: number, loot: LootEntry[]) => ({ type: "loot", raid: 1, rev, t, data: { loot } }) as RecordedMessage;
    tl.ingest(msg(1000, 1, [corpse([{ tpl: "b" }, { tpl: "c" }]), item]));
    tl.ingest(msg(2000, 2, [corpse([{ tpl: "c" }])]));
    const [changed, removed] = [tl.events.find((e) => e.kind === "lootChanged")!, tl.events.find((e) => e.kind === "lootRemoved")!];
    expect(describeEvent(changed, tl, catalog)).toMatchObject({ text: "corpse: −M4A1", tone: "loot", sel: { kind: "loot", id: 5 }, showAt: 2000 });
    expect(describeEvent(removed, tl, catalog)).toMatchObject({ text: "LEDX gone", pos: [4, 5, 6], showAt: 1999 });
    expect(eventConcerns(removed, { kind: "loot", id: 6 })).toBe(true);
    expect(eventConcerns(removed, { kind: "player", id: 6 })).toBe(false);
    expect(eventGroup("lootRemoved")).toBe("taken");
  });
});

describe("Track trails", () => {
  it("keep a point per metre of movement", () => {
    const tl = new Timeline();
    for (let i = 0; i < 50; i++) {
      const p: Player = { ...base, pos: [i * 0.25, 0, 0] };
      tl.ingest({ type: "players", raid: 1, rev: i + 1, t: 1000 + i * 100, data: { players: [p] } } as RecordedMessage);
    }
    const track = tl.tracks.get(2)!;
    expect(track.n).toBe(50);
    const kept = track.trailIndices();
    expect(kept.length).toBe(13); // 0 m, 1 m, …, 12 m
    expect(track.posOf(kept[1]!)).toEqual([1, 0, 0]);
    expect(track.distanceUntil(1000 + 49 * 100)).toBeCloseTo(12.25);
    expect(track.distanceUntil(1000 + 4 * 100)).toBeCloseTo(1);
  });

  it("don't count teleports as distance travelled", () => {
    const tl = new Timeline();
    const at = (i: number, x: number) =>
      tl.ingest({ type: "players", raid: 1, rev: i + 1, t: 1000 + i * 100, data: { players: [{ ...base, pos: [x, 0, 0] }] } } as RecordedMessage);
    at(0, 0);
    at(1, 0.5);
    at(2, 200.5); // 200 m in 100 ms
    at(3, 201);
    expect(tl.tracks.get(2)!.distanceUntil(1300)).toBeCloseTo(1);
  });

  it("call a step a jump only when nobody could make it", () => {
    expect(isJump(7, 1000)).toBe(false); // sprinting
    expect(isJump(4, 10)).toBe(false); // too short to judge
    expect(isJump(50, 100)).toBe(true);
    expect(isJump(50, 10_000)).toBe(false); // out of sight for a while
  });
});
