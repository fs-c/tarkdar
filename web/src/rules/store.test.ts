import { describe, expect, it } from "vitest";
import { emptyCatalog } from "../items";
import type { AnyRow, SubjectKind } from "../list/rows";
import { applyRules } from "./rules";
import { EMPTY_STORE, type RuleStore, fromLegacyPrefs, normalizeStore, storedRules } from "./store";

const row = (key: string, subject: SubjectKind, extra: Record<string, unknown> = {}) =>
  ({ key, subject, tpls: [], search: "", pos: null, sel: { kind: "loot", id: 0 }, ...extra }) as unknown as AnyRow;
const styleOf = (store: RuleStore, r: AnyRow) => applyRules([r], storedRules(store), emptyCatalog).styles.get(r.key)!;
const store = (patch: Partial<RuleStore>): RuleStore => ({ ...EMPTY_STORE, hidden: [], ...patch });

describe("stored rules", () => {
  it("apply changes to built-in rules: style properties and value bounds", () => {
    const s = store({ edits: { "player.usec": { color: "#123456", emphasis: "loud" }, "item.cheap": { maxValue: 30_000, label: "never" } } });
    expect(styleOf(s, row("player:1", "player", { type: "usec" }))).toMatchObject({ color: "#123456", emphasis: "loud" });
    expect(styleOf(s, row("loot:1", "item", { value: 25_000 }))).toMatchObject({ emphasis: "faint", label: "never" });
    expect(styleOf(store({}), row("loot:1", "item", { value: 25_000 })).emphasis).toBe("normal");
  });

  it("hide groups that are off; standing rules and their matches show through", () => {
    const s = store({ hidden: ["Loot"], mine: [{ id: "mine:1", label: "LEDX", kind: "Item", match: { tpls: ["ledx"] }, style: { color: "#f00", show: 0 }, on: true }] });
    expect(styleOf(s, row("loot:1", "item", { tpls: ["bolts"] })).show).toBeNull();
    expect(styleOf(s, row("loot:2", "item", { tpls: ["ledx"] }))).toMatchObject({ show: 0, color: "#f00" });
    expect(styleOf(s, row("exfil:1", "exfil")).show).toBe(0);
  });

  it("skip standing rules that are off", () => {
    const s = store({ mine: [{ id: "mine:1", label: "", kind: "", match: { tpls: ["ledx"] }, style: { color: "#f00" }, on: false }] });
    expect(styleOf(s, row("loot:2", "item", { tpls: ["ledx"] })).color).not.toBe("#f00");
  });

  it("drop what they don't know when read: unknown rules, groups, properties; empty standing rules", () => {
    const n = normalizeStore({
      edits: { "player.usec": { color: "#fff", emphasis: "huge", bogus: 1 }, "no.such.rule": { color: "#fff" } },
      hidden: ["Loot", "Players", 3],
      mine: [{ id: "mine:1", match: {}, style: {} }, { id: "mine:2", label: "x", match: { tpls: ["a"] }, style: { show: null }, on: false }, "junk"],
    });
    expect(n.edits).toEqual({ "player.usec": { color: "#fff" } });
    expect(n.hidden).toEqual(["Loot"]);
    expect(n.mine).toEqual([{ id: "mine:2", label: "x", kind: "", match: { tpls: ["a"] }, style: { show: null }, on: false }]);
    expect(normalizeStore("garbage")).toEqual(EMPTY_STORE);
  });

  it("start from the old Map panel settings: layers, loot density, label threshold", () => {
    expect(fromLegacyPrefs(null, null)).toEqual(EMPTY_STORE);
    expect(EMPTY_STORE.hidden).toEqual(["Loot", "Containers"]);
    expect(fromLegacyPrefs({ loot: true, containers: false, exfils: false, explosives: true }, null).hidden).toEqual(["Containers", "Exfils"]);
    expect(fromLegacyPrefs(null, { density: "fewer", minLabelPrice: 0 }).edits).toEqual({});
    expect(fromLegacyPrefs(null, { density: "all", minLabelPrice: 25_000 }).edits).toEqual({ "item.all": { show: 0 }, "item.cheap": { show: 0, label: "never" } });
    expect(fromLegacyPrefs(null, { density: "fewest" }).edits).toEqual({ "item.all": { show: 1 }, "item.cheap": { show: 2.5 } });
  });
});
