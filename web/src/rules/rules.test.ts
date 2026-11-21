import { describe, expect, it } from "vitest";
import { emptyCatalog } from "../model/items";
import type { AnyRow } from "../list/rows";
import { HIGHLIGHT_COLORS } from "../highlight/match";
import { highlightRules } from "./useRules";
import { BASE, type Rule, applyRules, explainStyle, highlightRule, isShown, labelAt } from "./rules";

// Rows matched by text (their key is their search text).
const row = (key: string, extra: Record<string, unknown> = {}) =>
  ({ key, subject: "item", tpls: [key], search: key, pos: null, sel: { kind: "loot", id: 0 }, ...extra }) as unknown as AnyRow;
const rule = (id: string, query: string, style: Rule["style"], extra: Partial<Rule> = {}): Rule => ({ id, label: id, query, style, ...extra });

describe("applyRules", () => {
  it("starts from the kind's base style; later rules win property by property", () => {
    const rows = [row("a", { value: 50_000 }), row("b", { value: 5_000 })];
    const { styles } = applyRules(rows, [
      rule("all", "is:item", { color: "white", emphasis: "normal" }),
      rule("dear", "value>=10k", { color: "gold" }),
      rule("ringed", "a", { ring: "red", emphasis: "strong" }),
    ], emptyCatalog);
    expect(styles.get("a")).toEqual({ ...BASE.item, color: "gold", emphasis: "strong", ring: "red" });
    expect(styles.get("b")).toEqual({ ...BASE.item, color: "white", emphasis: "normal" });
  });

  it("skips rules that are off, but still counts what they match", () => {
    const { styles, matched } = applyRules([row("a"), row("b")], [rule("off", "a", { color: "red" }, { on: false })], emptyCatalog);
    expect(styles.get("a")?.color).toBeUndefined();
    expect(matched.get("off")?.map((r) => r.key)).toEqual(["a"]);
  });

  it("hides the kinds switched off, except what's ringed", () => {
    const { styles } = applyRules([row("a"), row("b")], [rule("all", "is:item", { show: 0 }), rule("ring", "a", { ring: "red" })], emptyCatalog, new Set(["item"]));
    expect([styles.get("a")?.show, styles.get("b")?.show]).toEqual([0, null]);
  });

  it("shows nothing but players without a rule that shows it", () => {
    const { styles } = applyRules([row("a")], [rule("all", "is:item", { show: 0 }, { on: false }), rule("gold", "a", { color: "gold" })], emptyCatalog);
    expect(styles.get("a")?.show).toBeNull();
    expect(BASE.player.show).toBe(0);
  });

  it("tells when a thing shows and when it's labelled", () => {
    const s = { ...BASE.item, show: 1, labelFrom: 2 };
    expect([isShown(s, 0.5), isShown(s, 1), isShown({ ...s, show: null }, 9)]).toEqual([false, true, false]);
    expect([labelAt(s, 1), labelAt(s, 2), labelAt({ ...s, label: "always" }, 2), labelAt({ ...s, label: "never" }, 9)]).toEqual([null, { forced: false }, { forced: true }, null]);
  });
});

describe("explainStyle", () => {
  it("lists the rules that match, what each sets and what was overridden", () => {
    const rules = [rule("all", "is:item", { color: "white", show: 1 }), rule("off", "a", { color: "blue" }, { on: false }), rule("a", "a", { color: "gold" }), rule("b", "b", { color: "red" })];
    const { parts, style, hiddenByGroup } = explainStyle(row("a"), rules, emptyCatalog, new Set(["item"]));
    expect(parts.map((p) => [p.rule.id, p.set, p.overridden])).toEqual([["all", ["color", "show"], ["color"]], ["a", ["color"], []]]);
    expect(style).toMatchObject({ color: "gold", show: null });
    expect(hiddenByGroup).toBe(true);
  });
});

describe("highlights as rules", () => {
  it("show and ring what they match; an empty one matches nothing", () => {
    const { styles } = applyRules([row("a")], [rule("hide", "is:item", { show: null }), highlightRule("h", "", "a", "red", true)], emptyCatalog);
    expect(styles.get("a")).toMatchObject({ show: 0, ring: "red" });
    expect(applyRules([row("a")], [highlightRule("h", "", " ", "red", true)], emptyCatalog).matched.get("h")).toEqual([]);
  });

  it("colour each thing by the first pill that matches it; the preview only where no pill does", () => {
    const h = (id: number, color: string, query: string, on = true) => ({ id, label: "", group: "", query, color, on });
    const rules = highlightRules([h(1, "red", "a"), h(2, "blue", "is:item b"), h(3, "green", "c", false)], "is:item");
    // "is:item b": rows a..d all contain no "b" except b.
    const { styles, matched } = applyRules(["a", "b", "c", "d"].map((k) => row(k)), rules, emptyCatalog);
    expect(["a", "b", "c", "d"].map((k) => styles.get(k)?.ring)).toEqual(["red", "blue", HIGHLIGHT_COLORS[0], HIGHLIGHT_COLORS[0]]);
    expect(matched.get("highlight:3")?.map((r) => r.key)).toEqual(["c"]);
  });
});
