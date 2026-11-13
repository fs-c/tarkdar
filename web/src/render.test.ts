import { describe, expect, it } from "vitest";
import { darken } from "./render";
import { COLORS, PLAYER_TYPES_LOOK, playerLook } from "./style";

describe("darken", () => {
  it("mixes #rrggbb towards black, leaves other formats alone", () => {
    expect(darken("#ff8000", 0)).toBe("#ff8000");
    expect(darken("#ff8000", 0.5)).toBe("rgb(128, 64, 0)");
    expect(darken("#ff8000", 2)).toBe("rgb(0, 0, 0)");
    expect(darken("rgba(1, 2, 3, 0.5)", 0.5)).toBe("rgba(1, 2, 3, 0.5)");
  });
});

describe("player looks", () => {
  it("follow prominence: special players get a halo and a named, coloured label; minor ones are dimmed", () => {
    expect(playerLook("boss")).toMatchObject({ radius: 7, halo: { gap: 4, width: 2 }, namedLabel: true, labelColor: PLAYER_TYPES_LOOK.boss.color });
    expect(playerLook("follower").halo).toEqual({ gap: 3, width: 1.5 });
    expect(playerLook("ai-scav")).toMatchObject({ radius: 4, alpha: 0.55, dim: true, halo: null, namedLabel: false });
    expect(playerLook("usec")).toMatchObject({ halo: null, order: 2, dim: false });
  });
  it("grey out the dead (drawn low, label in the plain colour) and fade those who left", () => {
    expect(playerLook("boss", { dead: true })).toMatchObject({ color: COLORS.dead, labelColor: COLORS.label, order: 1 });
    expect(playerLook("self", { dead: true }).order).toBe(4);
    expect(playerLook("ai-scav", { absent: true }).alpha).toBeCloseTo(0.55 * 0.35);
  });
  it("sort bottom to top: minor, dead, normal, special and bosses, us", () => {
    const order = (t: Parameters<typeof playerLook>[0], dead = false) => playerLook(t, { dead }).order;
    expect([order("ai-scav"), order("usec", true), order("usec"), order("raider"), order("boss"), order("self")]).toEqual([0, 1, 2, 3, 3, 4]);
  });
});
