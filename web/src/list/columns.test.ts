import { describe, expect, it } from "vitest";
import { BASE } from "../rules/rules";
import { stylesFor } from "../rules/rules.fixture";
import { isLoud } from "./columns";

describe("bold in the list", () => {
  it("goes by the style's emphasis, not the player's type", () => {
    expect(isLoud({ ...BASE.player, emphasis: "loud" })).toBe(true);
    for (const emphasis of ["faint", "normal", "strong"] as const) expect(isLoud({ ...BASE.player, emphasis })).toBe(false);
    expect(isLoud(undefined)).toBe(false);
  });

  it("is the bosses out of the box", () => {
    const players = [1, 2].map((id) => ({ id, local: false, ai: true, side: "savage" as const, dead: false, absent: false, pos: [0, 0, 0] as [number, number, number], yaw: 0, pitch: 0, voice: id === 1 ? "BossBully" : undefined }));
    const styles = stylesFor({ players });
    expect([styles.get("player:1"), styles.get("player:2")].map(isLoud)).toEqual([true, false]);
  });
});
