import { describe, expect, it } from "vitest";
import { emptyCatalog } from "../model/items";
import type { AnyRow, SubjectKind } from "../list/rows";
import { DEFAULT_RULES } from "./defaults";
import { applyRules } from "./rules";
import {
  type RuleStore, type StoredRule, addRule, defaultStore, duplicateRule, hiddenKinds, isChanged, missingDefaults, moveRule,
  normalizeStore, removeRule, resetCategory, categoryChanged, restoreDefaults, ruleStore, storedRules, updateRule,
} from "./store";
import { decode } from "../persist/store";
import { COLORS } from "../draw/style";
import type { Vehicle } from "../model/protocol";
import { stylesFor } from "./rules.fixture";

const row = (key: string, subject: SubjectKind, extra: Record<string, unknown> = {}) =>
  ({ key, subject, tpls: [], search: "", pos: null, sel: { kind: "loot", id: 0 }, ...extra }) as unknown as AnyRow;
const styleOf = (store: RuleStore, r: AnyRow, pinned: StoredRule[] = []) =>
  applyRules([r], storedRules(store, pinned), emptyCatalog, hiddenKinds(store)).styles.get(r.key)!;
const store = (patch: Partial<RuleStore> = {}): RuleStore => ({ ...defaultStore(), hidden: [], ...patch });
const mine = (id: string, query: string, extra: Partial<StoredRule> = {}): StoredRule => ({ id, category: "General", label: id, query, style: { color: "#f00" }, on: true, ...extra });
const ids = (rs: StoredRule[]) => rs.map((r) => r.id);

describe("stored rules", () => {
  it("apply in category order, General over the rest, pinned over all", () => {
    const s = store();
    s.rules = addRule(s.rules, mine("g", "is:usec"));
    expect(styleOf(s, row("player:1", "player", { type: "usec" })).color).toBe("#f00");
    expect(storedRules(s).at(-1)!.id).toBe("g");
    expect(styleOf(s, row("player:1", "player", { type: "usec" }), [mine("p", "is:usec", { style: { color: "#0f0" } })]).color).toBe("#0f0");
  });

  it("hide the categories that are off; ringed things show through", () => {
    const s = store({ hidden: ["Loot"] });
    expect(styleOf(s, row("loot:1", "item")).show).toBeNull();
    expect(styleOf(s, row("loot:2", "item", { search: "ledx" }), [mine("p", "ledx", { style: { ring: "#f00", show: 0 } })])).toMatchObject({ show: 0, ring: "#f00" });
    expect(styleOf(s, row("exfil:1", "exfil")).show).toBe(0);
  });

  it("change, move (within a category), duplicate and remove", () => {
    let rs = defaultStore().rules;
    rs = updateRule(rs, "player.usec", { style: { color: "#123456" } });
    expect(rs.find((r) => r.id === "player.usec")!.style).toEqual({ color: "#123456" });
    // The last player rule up: nothing above it in Players (Loot isn't crossed).
    expect(ids(moveRule(rs, "player.other", 1))).toEqual(ids(rs));
    const moved = moveRule(rs, "player.bear", -1);
    expect(ids(moved).slice(0, 2)).toEqual(["player.bear", "player.usec"]);
    const dup = duplicateRule(rs, "player.bear");
    expect(dup[2]).toMatchObject({ label: "BEAR (copy)", query: "is:bear", category: "Players" });
    expect(dup[2]!.origin).toBeUndefined();
    expect(removeRule(rs, "player.bear")).toHaveLength(rs.length - 1);
  });

  it("add rules on top of their category, even an empty one", () => {
    const rs = defaultStore().rules;
    const added = addRule(rs, mine("x", "a", { category: "Players" }));
    expect(added.findIndex((r) => r.id === "x")).toBe(rs.filter((r) => r.category === "Players").length);
    expect(addRule(rs, mine("y", "a")).at(-1)!.id).toBe("y"); // General: empty, last
  });

  it("know what changed from a default, reset a category, and restore removed defaults where they were", () => {
    const defaults = defaultStore().rules;
    let rs = defaults;
    expect(rs.some(isChanged)).toBe(false);
    expect(categoryChanged(rs, "Loot")).toBe(false);
    rs = updateRule(rs, "item.cheap", { query: "is:item value<5k" });
    expect(isChanged(rs.find((r) => r.id === "item.cheap")!)).toBe(true);
    expect(categoryChanged(rs, "Loot")).toBe(true);
    expect(categoryChanged(rs, "Players")).toBe(false);
    rs = addRule(rs, mine("x", "a", { category: "Loot" }));
    rs = moveRule(rs, "player.usec", 1);
    expect(categoryChanged(rs, "Players")).toBe(true);
    rs = resetCategory(rs, "Loot");
    expect(categoryChanged(rs, "Loot")).toBe(false);
    expect(categoryChanged(rs, "Players")).toBe(true); // other categories untouched
    rs = resetCategory(rs, "Players");
    expect(ids(rs)).toEqual(ids(defaults));
    const without = removeRule(removeRule(rs, "item.cheap"), "player.usec");
    expect(missingDefaults(without)).toBe(2);
    expect(ids(restoreDefaults(without))).toEqual(ids(rs));
  });

  it("drop what they don't know when read; an older format gives the defaults", () => {
    const n = normalizeStore({
      rules: [
        { id: "a", origin: "player.usec", category: "Players", label: "A", query: "is:usec", style: { color: "#fff", emphasis: "huge", bogus: 1 } },
        { id: "a", category: "Players", query: "" }, // duplicate id
        { id: "b", category: "Nowhere", query: "" },
        { id: "c", origin: "no.such", category: "General", query: "x", on: false },
        "junk",
      ],
      hidden: ["Loot", "Players", 3],
    });
    expect(n.rules).toEqual([
      { id: "a", origin: "player.usec", category: "Players", label: "A", query: "is:usec", style: { color: "#fff" }, on: true },
      { id: "c", category: "General", label: "", query: "x", style: {}, on: false },
    ]);
    expect(n.hidden).toEqual(["Loot"]);
    expect(normalizeStore("garbage")).toEqual(defaultStore());
    expect(decode(ruleStore, JSON.stringify({ edits: {}, hidden: [], mine: [] }))).toMatchObject({ value: defaultStore(), status: "failed" }); // an old format
    expect(decode(ruleStore, JSON.stringify({ version: 3, rules: [], hidden: ["Loot"] }))).toMatchObject({ value: { rules: [expect.objectContaining({ id: "vehicle" }), expect.objectContaining({ id: "gear.quest-needed" })], hidden: ["Loot"] }, status: "migrated" });
    expect(defaultStore().rules).toHaveLength(DEFAULT_RULES.length);
  });

  it("give vehicles the default rule; switching the Vehicles category off hides them; a changed colour applies", () => {
    const btr: Vehicle = { id: 1, kind: "btr", state: 2, pos: [0, 0, 0], yaw: 0, occupants: [] };
    const s = store();
    expect(stylesFor({ vehicles: [btr] }, s).get("vehicle:1")).toMatchObject({ show: 0, color: COLORS.vehicle, label: "always" });
    expect(stylesFor({ vehicles: [btr] }, { ...s, hidden: ["Vehicles"] }).get("vehicle:1")!.show).toBeNull();
    s.rules = updateRule(s.rules, "vehicle", { style: { color: "#123456", show: 0 } });
    expect(stylesFor({ vehicles: [btr] }, s).get("vehicle:1")!.color).toBe("#123456");
  });

  it("add the vehicle rule to stored lists that predate it, once", () => {
    const old = { $v: 1, data: { rules: [{ id: "r:1", category: "Loot", label: "GPUs", query: "gpu", style: {}, on: true }], hidden: ["Loot"] } };
    const d = decode(ruleStore, JSON.stringify(old));
    expect(d.status).toBe("migrated");
    expect(d.value.rules.map((r) => r.id)).toEqual(["r:1", "vehicle", "gear.quest-needed"]);
    expect(d.value.rules[1]).toEqual(defaultStore().rules.find((r) => r.id === "vehicle"));
    expect(d.value.hidden).toEqual(["Loot"]);
    expect(missingDefaults(d.value.rules)).toBe(DEFAULT_RULES.length - 2); // the vehicle and gear rules are no longer missing
  });

  it("ring corpses and players carrying what a quest needs, also with Containers off; a boss keeps its colour", () => {
    const off = { ...defaultStore(), hidden: ["Containers" as const] };
    const corpse = styleOf(off, row("loot:1", "corpse", { questNeeded: true }));
    expect(corpse).toMatchObject({ ring: "#ffd84d", show: 0 });
    expect(styleOf(off, row("loot:2", "corpse")).show).toBeNull();
    const boss = styleOf(store(), row("player:1", "player", { questNeeded: true, type: "boss", ai: true, state: "alive" }));
    expect(boss).toMatchObject({ ring: "#ffd84d", color: "#ff4fd8" });
  });

  it("add the rule for carried needed items to stored lists that predate it, once", () => {
    const v2 = { $v: 2, data: { rules: [{ id: "r:1", category: "Loot", label: "GPUs", query: "gpu", style: {}, on: true }], hidden: [] } };
    const d = decode(ruleStore, JSON.stringify(v2));
    expect(d.value.rules.map((r) => r.id)).toEqual(["r:1", "gear.quest-needed"]);
    expect(d.value.rules[1]).toEqual(defaultStore().rules.find((r) => r.id === "gear.quest-needed"));
    expect(decode(ruleStore, JSON.stringify({ $v: 3, data: d.value })).value.rules.map((r) => r.id)).toEqual(["r:1", "gear.quest-needed"]);
  });

  it("use the default rules when there's no list of them (an empty one stays empty)", () => {
    expect(normalizeStore({ hidden: ["Loot"] })).toEqual({ ...defaultStore(), hidden: ["Loot"] });
    expect(normalizeStore({ rules: "x", hidden: [] }).rules).toEqual(defaultStore().rules);
    expect(normalizeStore({ rules: [], hidden: [] }).rules).toEqual([]);
  });

  it("don't take inherited names for categories", () => {
    expect(normalizeStore({ rules: [], hidden: ["toString", "constructor", "Loot"] }).hidden).toEqual(["Loot"]);
  });
});
