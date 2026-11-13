import { describe, expect, it } from "vitest";
import { SlimCatalog } from "../catalog";
import { parseValue, suggest } from "./suggest";

const catalog = new SlimCatalog(
  {
    ledx: ["LEDX Skin Transilluminator", "LEDX", 900_000, 0, ["meds", "barter"]],
    gpu: ["Graphics card", "GPU", 400_000, 0, ["elec", "barter"]],
    gpu2: ["Graphics card", "GPU", 400_000, 0, ["elec", "barter"]],
    tetriz: ["Tetriz portable game console", "Tetriz", 30_000, 0, ["elec", "barter"]],
  },
  { barter: ["Barter items", null], elec: ["Electronics", "barter"], meds: ["Medical supplies", "barter"] },
);

describe("parseValue", () => {
  it("reads thresholds with a comparison or a unit; a bare number is text", () => {
    expect(parseValue("≥50k")).toBe(50_000);
    expect(parseValue(">= 20000")).toBe(20_000);
    expect(parseValue("1.5m")).toBe(1_500_000);
    expect(parseValue("100K₽")).toBe(100_000);
    expect(parseValue("50")).toBeNull();
    expect(parseValue("ak 74")).toBeNull();
  });
});

describe("suggest", () => {
  const groups = (q: string) => suggest(q, catalog).map((s) => `${s.group}:${s.label}`);

  it("offers the text first, then what it could mean", () => {
    expect(groups("elec")).toEqual(['Text:"elec"', "Category:Electronics"]);
    expect(groups("gpu")).toEqual(['Text:"gpu"', "Item:GPU"]);
    expect(groups("bos")).toEqual(['Text:"bos"', "Players:Special", "Players:Bosses"]);
    expect(groups("")).toEqual([]);
  });

  it("merges items that share a name", () => {
    expect(suggest("graphics", catalog).find((s) => s.group === "Item")?.match).toEqual({ tpls: ["gpu", "gpu2"] });
  });

  it("gives a category's parents as detail", () => {
    expect(suggest("electronics", catalog).find((s) => s.group === "Category")).toMatchObject({ detail: "Barter items", match: { categories: ["elec"] } });
  });

  it("turns a value into thresholds for items and for gear", () => {
    expect(suggest("≥50k", catalog).slice(1).map((s) => s.match)).toEqual([
      { subjects: ["item"], minValue: 50_000 },
      { subjects: ["player", "corpse"], minValue: 50_000 },
    ]);
  });
});
