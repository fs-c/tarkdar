import { describe, expect, it, vi } from "vitest";
import { type MapEntry, findMap, validEntry } from "./maps";

describe("findMap", () => {
  const index: MapEntry[] = [
    { folder: "labs", config: { name: "Labs", ids: ["laboratory", "laboratory_event"] } },
    { folder: "customs", config: { name: "Customs", ids: ["bigmap"] } },
  ];
  it("matches location ids case-insensitively", () => {
    expect(findMap(index, "Laboratory_Event")?.folder).toBe("labs");
    expect(findMap(index, "BIGMAP")?.folder).toBe("customs");
    expect(findMap(index, "woods")).toBeUndefined();
  });
});

describe("validEntry", () => {
  const good = { folder: "customs", config: { name: "Customs", ids: ["bigmap"] } };
  it("accepts a well-formed entry and rejects malformed ones", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(validEntry(good)).toBe(true);
    expect(validEntry({ ...good, config: { ids: ["bigmap"] } })).toBe(false);
    expect(validEntry({ ...good, config: { ...good.config, ids: "x" } })).toBe(false);
    expect(validEntry({ ...good, folder: undefined })).toBe(false);
    expect(validEntry({ folder: "y" })).toBe(false);
    expect(validEntry(null)).toBe(false);
    spy.mockRestore();
  });
});
