import { describe, expect, it } from "vitest";
import { COLORS, DEFAULT_COLOR } from "../draw/style";
import { playerRows } from "../list/rows";
import { emptyCatalog } from "../model/items";
import type { Player } from "../model/protocol";
import { storeFrom, stylesFor } from "../rules/rules.fixture";
import { updateRule } from "../rules/store";
import { povPlayerLook } from "./playerLook";

const player = (id: number, extra: Partial<Player> = {}): Player =>
  ({ id, local: false, ai: false, side: "usec", dead: false, absent: false, pos: [0, 0, 0], yaw: 0, pitch: 0, ...extra });

/** Each player's look on the POV page, by id, with the rules of `store`. */
function looks(players: Player[], store = storeFrom()) {
  const styles = stylesFor({ players }, store);
  return Object.fromEntries(playerRows(players, new Map(), emptyCatalog).map((r) => [r.sel.id, povPlayerLook(r, styles.get(r.key))]));
}

describe("the player's view's players", () => {
  const players = [player(1), player(2, { side: "bear", ai: true }), player(3, { side: "savage", ai: false })];

  it("take the colour the rules give them, and the type's label", () => {
    expect(looks(players)).toEqual({
      1: { color: "#4aa3ff", label: "USEC" },
      2: { color: "#ff5a52", label: "BEAR bot" },
      3: { color: "#f5c542", label: "Player scav" },
    });
  });

  it("follow a changed rule", () => {
    const store = storeFrom();
    store.rules = updateRule(store.rules, "player.usec", { style: { color: "#123456" } });
    expect(looks(players, store)[1]!.color).toBe("#123456");
  });

  it("are left out when the rules hide them", () => {
    const store = storeFrom();
    store.rules = updateRule(store.rules, "player.bear", { style: { show: null } });
    expect(looks(players, store)[2]).toBeNull();
    expect(looks(players, store)[1]).not.toBeNull();
  });

  it("are grey and labelled dead when dead, as on the map", () => {
    expect(looks([player(1, { dead: true })])[1]).toEqual({ color: COLORS.dead, label: "dead" });
  });

  it("use the default colour where no rule colours them", () => {
    const store = storeFrom();
    store.rules = store.rules.filter((r) => r.category !== "Players");
    expect(looks(players, store)[1]).toEqual({ color: DEFAULT_COLOR, label: "USEC" });
  });
});
