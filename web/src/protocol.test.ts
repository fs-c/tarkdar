import { describe, expect, it } from "vitest";
import { parseMessage, withoutContainerContents } from "./protocol";
import { parseLine } from "./recordings";

describe("withoutContainerContents", () => {
  const entries = [
    { id: 1, kind: "container", tpl: "safe", obj: "", pos: [0, 0, 0], contents: [{ tpl: "rub" }] },
    { id: 2, kind: "corpse", tpl: "", obj: "", pos: [0, 0, 0], contents: [{ tpl: "m4" }] },
  ];

  it("drops container contents from live messages, keeps corpse equipment", () => {
    const m = parseMessage(JSON.stringify({ type: "loot", rev: 1, t: 0, raid: 1, data: { loot: entries } }));
    expect(m?.type === "loot" && m.data.loot.map((l) => l.contents)).toEqual([undefined, [{ tpl: "m4" }]]);
  });

  it("does the same for recorded diffs", () => {
    const m = parseLine(JSON.stringify({ type: "lootDiff", rev: 1, t: 0, raid: 1, data: { added: entries, removed: [], changed: entries } }));
    expect(m?.type === "lootDiff" && m.data.changed.map((l) => !!l.contents)).toEqual([false, true]);
    expect(m?.type === "lootDiff" && m.data.added.map((l) => !!l.contents)).toEqual([false, true]);
  });

  it("leaves other messages alone", () => {
    const m = { type: "exfils", rev: 1, t: 0, raid: 1, data: { exfils: [] } } as const;
    expect(withoutContainerContents(m as never)).toBe(m);
  });
});
