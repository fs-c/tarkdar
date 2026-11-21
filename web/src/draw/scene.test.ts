import { describe, expect, it } from "vitest";
import type { Timeline } from "../stream/timeline";
import { trailScene } from "./scene";

const timeline = {} as Timeline;
const players = [{ id: 1 }, { id: 2 }] as Parameters<typeof trailScene>[0]["players"];
const base = { timeline, at: 600_000, players, selection: null };

describe("trailScene", () => {
  it("is nothing without a timeline or a shown moment", () => {
    const prefs = { selected: true, all: true, minutes: 5 };
    expect(trailScene({ ...base, prefs, timeline: null })).toBeNull();
    expect(trailScene({ ...base, prefs, at: null })).toBeNull();
  });
  it("gives everyone a trail of the chosen length, or the whole raid", () => {
    const five = trailScene({ ...base, prefs: { selected: false, all: true, minutes: 5 } });
    expect([...five!.since]).toEqual([[1, 300_000], [2, 300_000]]);
    const whole = trailScene({ ...base, prefs: { selected: false, all: true, minutes: null } });
    expect(whole!.since.get(1)).toBe(-Infinity);
  });
  it("gives the selected player the whole raid, over the shared length", () => {
    const selection = { kind: "player" as const, id: 2 };
    const s = trailScene({ ...base, selection, prefs: { selected: true, all: true, minutes: 5 } });
    expect(s!.since.get(1)).toBe(300_000);
    expect(s!.since.get(2)).toBe(-Infinity);
    expect(s!.selected).toBe(2);
  });
  it("is nothing when no trail is asked for", () => {
    const selection = { kind: "loot" as const, id: 2 };
    expect(trailScene({ ...base, selection, prefs: { selected: true, all: false, minutes: 5 } })).toBeNull();
  });
});
