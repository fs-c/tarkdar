import { describe, expect, it, vi } from "vitest";
import { type MapEntry, findMap, selectLayer, validEntry } from "./maps";

const layers = [{ image: "b", maxY: -1 }, { image: "0", maxY: 3 }, { image: "1" }];

describe("selectLayer", () => {
  it("picks the first layer whose bound is above y", () => {
    expect(selectLayer(layers, -5, null)).toBe(0);
    expect(selectLayer(layers, 0, null)).toBe(1);
    expect(selectLayer(layers, 10, null)).toBe(2);
  });
  it("applies hysteresis around boundaries", () => {
    expect(selectLayer(layers, 3.3, 1, 0.5)).toBe(1); // just above the bound: stay
    expect(selectLayer(layers, 3.6, 1, 0.5)).toBe(2); // clearly above: switch
    expect(selectLayer(layers, 2.7, 2, 0.5)).toBe(2); // just below while upstairs: stay
    expect(selectLayer(layers, 2.4, 2, 0.5)).toBe(1);
  });
  it("handles a single layer", () => {
    expect(selectLayer([{ image: "x" }], 123, null)).toBe(0);
  });
});

describe("findMap", () => {
  const index: MapEntry[] = [
    { kind: "2d", folder: "labs", config: { name: "Labs", ids: ["laboratory", "laboratory_event"], calibration: { points: [] }, layers: [] } },
    { kind: "2d", folder: "customs", config: { name: "Customs", ids: ["bigmap"], calibration: { points: [] }, layers: [] } },
    { kind: "3d", folder: "customs", config: { name: "Customs", ids: ["bigmap"] } },
  ];
  it("matches location ids case-insensitively", () => {
    expect(findMap(index, "Laboratory_Event")?.folder).toBe("labs");
    expect(findMap(index, "woods")).toBeUndefined();
  });
  it("prefers the 3D map, or the 2D one on request", () => {
    expect(findMap(index, "bigmap")?.kind).toBe("3d");
    expect(findMap(index, "BIGMAP", true)?.kind).toBe("2d");
    expect(findMap(index, "laboratory")?.kind).toBe("2d"); // only a 2D map exists
    expect(findMap(index.slice(2), "bigmap", true)?.kind).toBe("3d"); // only a 3D map exists
  });
});

describe("validEntry", () => {
  const good = { kind: "2d", folder: "x", config: { name: "X", ids: ["x"], layers: [{ image: "a.png" }], calibration: { points: [{ world: [0, 0], pixel: [0, 0] }, { world: [1, 1], pixel: [1, -1] }] } } };
  it("accepts a well-formed entry and rejects malformed ones", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(validEntry(good)).toBe(true);
    expect(validEntry({ ...good, config: { ...good.config, ids: "x" } })).toBe(false);
    expect(validEntry({ ...good, config: { ...good.config, layers: [] } })).toBe(false);
    expect(validEntry({ ...good, kind: undefined })).toBe(false);
    expect(validEntry({ kind: "2d", folder: "y" })).toBe(false);
    expect(validEntry(null)).toBe(false);
    spy.mockRestore();
  });
  it("a 3D entry needs only a name and ids", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(validEntry({ kind: "3d", folder: "customs", config: { name: "Customs", ids: ["bigmap"] } })).toBe(true);
    expect(validEntry({ kind: "3d", folder: "customs", config: { ids: ["bigmap"] } })).toBe(false);
    expect(validEntry({ kind: "4d", folder: "customs", config: { name: "Customs", ids: ["bigmap"] } })).toBe(false);
    spy.mockRestore();
  });
});
