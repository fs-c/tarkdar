import { describe, expect, it } from "vitest";
import { darken, heightTag } from "./render";
import { COLORS, playerLook } from "./style";

describe("darken", () => {
  it("mixes #rrggbb towards black, leaves other formats alone", () => {
    expect(darken("#ff8000", 0)).toBe("#ff8000");
    expect(darken("#ff8000", 0.5)).toBe("rgb(128, 64, 0)");
    expect(darken("#ff8000", 2)).toBe("rgb(0, 0, 0)");
    expect(darken("rgba(1, 2, 3, 0.5)", 0.5)).toBe("rgba(1, 2, 3, 0.5)");
  });
});

describe("height tags", () => {
  it("say how far above or below us a labelled thing is, from 2 m on, and nothing without us", () => {
    expect(heightTag(13.4, 10)).toBe(" ▲3");
    expect(heightTag(-2, 10)).toBe(" ▼12");
    expect(heightTag(11.9, 10)).toBe("");
    expect(heightTag(20, null)).toBe("");
    expect(heightTag(undefined, 10)).toBe("");
  });
});

describe("player looks", () => {
  it("follow emphasis: strong and loud players get a halo and a named, coloured label; faint ones are dimmed", () => {
    expect(playerLook("loud", "#f0f")).toMatchObject({ radius: 7, halo: { gap: 4, width: 2 }, namedLabel: true, labelColor: "#f0f" });
    expect(playerLook("strong", "#f0f").halo).toEqual({ gap: 3, width: 1.5 });
    expect(playerLook("faint", "#f0f")).toMatchObject({ radius: 4, alpha: 0.55, dim: true, halo: null, namedLabel: false });
    expect(playerLook("normal", "#f0f")).toMatchObject({ halo: null, order: 2, dim: false, labelColor: COLORS.label });
  });
  it("draw the local player in its own colour, whatever the rules say", () => {
    expect(playerLook("self", "#f0f").color).toBe(COLORS.local);
  });
  it("grey out the dead (drawn low, label in the plain colour) and fade those who left", () => {
    expect(playerLook("loud", "#f0f", { dead: true })).toMatchObject({ color: COLORS.dead, labelColor: COLORS.label, order: 1 });
    expect(playerLook("self", "", { dead: true }).order).toBe(4);
    expect(playerLook("faint", "#f0f", { absent: true }).alpha).toBeCloseTo(0.55 * 0.35);
  });
  it("sort bottom to top: faint, dead, normal, strong and loud, us", () => {
    const order = (e: Parameters<typeof playerLook>[0], dead = false) => playerLook(e, "#fff", { dead }).order;
    expect([order("faint"), order("normal", true), order("normal"), order("strong"), order("loud"), order("self")]).toEqual([0, 1, 2, 3, 3, 4]);
  });
});
