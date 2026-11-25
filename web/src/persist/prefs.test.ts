import { DEFAULT_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, mapStore, sidebarSizeStore, sidebarStore } from "./prefs";
import { decode } from "./store";
import { DEFAULT_MAP_SETTINGS } from "../map3d/settings";

describe("stored map prefs", () => {
  it("fall back to the defaults for values that aren't among the known ones", () => {
    const m = mapStore.normalize({ style: "cubist", controls: "gamepad" });
    expect(m).toMatchObject({ style: "realistic", controls: "map" });
    expect(mapStore.normalize({ style: "plan", controls: "wasd" })).toMatchObject({ style: "plan", controls: "wasd" });
  });

  it("keep the orthographic projection chosen before there was an automatic one", () => {
    const load = (data: unknown, v = 1) => decode(mapStore, JSON.stringify({ $v: v, data })).value.projection;
    expect(load({ orthographic: true })).toBe("orthographic");
    expect(load({ orthographic: false })).toBe("auto");
    expect(load({})).toBe("auto");
    expect(load({ projection: "perspective" }, 2)).toBe("perspective");
    expect(load({ projection: "fisheye" }, 2)).toBe("auto");
  });

  it("keep palette colours only when they're #rrggbb", () => {
    const p = mapStore.normalize({ palette: { ground: "#123456", grass: "green", road: 5, water: "#12345" } }).palette;
    expect(p.ground).toBe("#123456");
    expect(p.grass).toBe(DEFAULT_MAP_SETTINGS.palette.grass);
    expect(p.road).toBe(DEFAULT_MAP_SETTINGS.palette.road);
    expect(p.water).toBe(DEFAULT_MAP_SETTINGS.palette.water);
    expect(mapStore.normalize({ customPalette: { tree: "nope" } }).customPalette).toEqual(DEFAULT_MAP_SETTINGS.palette);
  });
});

describe("stored sidebar prefs", () => {
  it("keep the width within a sane range", () => {
    expect(sidebarSizeStore.normalize({ width: 5 }).width).toBe(MIN_SIDEBAR_WIDTH);
    expect(sidebarSizeStore.normalize({ width: 1e9 }).width).toBe(MAX_SIDEBAR_WIDTH);
    expect(sidebarSizeStore.normalize({ width: 500 }).width).toBe(500);
    expect(sidebarSizeStore.normalize({ width: "wide" }).width).toBe(DEFAULT_SIDEBAR_WIDTH);
  });

  it("know their sections", () => {
    expect(sidebarStore.normalize({ section: "nowhere", raidsLevel: "deep" })).toMatchObject({ section: "players", raidsLevel: "list" });
  });
});
