import { describe, expect, it } from "vitest";
import { SlimCatalog } from "../model/catalog";
import { parseValue, suggest } from "./suggest";

const catalog = new SlimCatalog(
  {
    ledx: { name: "LEDX Skin Transilluminator", shortName: "LEDX", price: 900_000, priceSource: "flea", categories: ["meds", "barter"] },
    gpu: { name: "Graphics card", shortName: "GPU", price: 400_000, priceSource: "flea", categories: ["elec", "barter"] },
    gpu2: { name: "Graphics card", shortName: "GPU", price: 400_000, priceSource: "flea", categories: ["elec", "barter"] },
    tetriz: { name: "Tetriz portable game console", shortName: "Tetriz", price: 30_000, priceSource: "flea", categories: ["elec", "barter"] },
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

  it("finds items by name: variants that share it are one", () => {
    expect(suggest("graphics", catalog).filter((s) => s.group === "Item").map((s) => s.query)).toEqual(['item:"Graphics card"']);
  });

  it("offers kinds of container, their variants as one", () => {
    expect(groups("safe")).toEqual(['Text:"safe"', "Container:Safe"]);
    expect(suggest("weapon", catalog).find((s) => s.group === "Container")).toMatchObject({ label: "Weapon Box", query: 'is:container item:"Weapon Box"' });
  });

  it("gives a category's parents as detail", () => {
    expect(suggest("electronics", catalog).find((s) => s.group === "Category")).toMatchObject({ detail: "Barter items", query: "cat:Electronics" });
  });

  it("turns a value into thresholds for items (per slot) and for gear", () => {
    expect(suggest("≥50k", catalog).slice(1).map((s) => s.query)).toEqual(["is:item value>=50k", "is:player,corpse value>=50k"]);
  });

  it("takes a query as it is, or says what's wrong with it", () => {
    expect(suggest("is:boss gpu", catalog)).toEqual([{ label: "is:boss gpu", group: "Query", query: "is:boss gpu" }]);
    expect(suggest("is:bos", catalog)[0]).toMatchObject({ group: "Query", error: true });
  });

  it("teaches the syntax: a field's name gives an example", () => {
    expect(suggest("pen", catalog).find((s) => s.group === "Syntax")?.query).toBe("pen>=40");
  });
});
