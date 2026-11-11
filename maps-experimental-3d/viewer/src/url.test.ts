import { buildUrl, datasetFor, hasInspect, parseUrl } from "./url";

const DEFAULTS = { categories: null, paused: false };

describe("parseUrl", () => {
  it("defaults to the Customs overview", () => {
    expect(parseUrl("")).toEqual({ mode: "overview", map: "customs", dataset: "customs", ...DEFAULTS });
  });

  it("maps modes to datasets", () => {
    expect(parseUrl("?map=streets")).toEqual({ mode: "overview", map: "streets", dataset: "streets", ...DEFAULTS });
    expect(parseUrl("?map=customs-legacy").dataset).toBe("customs-legacy");
    expect(parseUrl("?mode=explore").dataset).toBe("customs-explore");
    expect(parseUrl("?mode=explore&map=streets").dataset).toBe("streets-explore");
    expect(parseUrl("?mode=inspect").dataset).toBe("customs-inspect");
  });

  it("explore exists per map, not per variant", () => {
    expect(parseUrl("?mode=explore&map=streets-legacy")).toEqual({ mode: "explore", map: "streets", dataset: "streets-explore", ...DEFAULTS });
  });

  it("inspect falls back to the overview dataset where no inspect build exists", () => {
    expect(parseUrl("?mode=inspect&map=streets")).toEqual({ mode: "inspect", map: "streets", dataset: "streets", ...DEFAULTS });
    expect(hasInspect("customs")).toBe(true);
    expect(hasInspect("streets")).toBe(false);
  });

  it("accepts dataset names as map names", () => {
    expect(parseUrl("?map=customs-explore")).toEqual({ mode: "explore", map: "customs", dataset: "customs-explore", ...DEFAULTS });
    expect(parseUrl("?map=customs-inspect")).toEqual({ mode: "inspect", map: "customs", dataset: "customs-inspect", ...DEFAULTS });
  });

  it("reads the category filter and the paused flag", () => {
    expect(parseUrl("?cats=structure,%20terrain,,water&paused")).toMatchObject({
      categories: ["structure", "terrain", "water"],
      paused: true,
    });
    expect(parseUrl("?cats=").categories).toBeNull();
  });

  it("ignores unknown modes", () => {
    expect(parseUrl("?mode=nope").mode).toBe("overview");
  });
});

describe("buildUrl", () => {
  it("omits defaults and round-trips", () => {
    expect(buildUrl("/", "overview", "customs")).toBe("/");
    expect(buildUrl("/", "explore", "streets")).toBe("/?mode=explore&map=streets");
    for (const mode of ["overview", "explore", "inspect"] as const) {
      for (const map of ["customs", "streets"]) {
        const url = buildUrl("/", mode, map);
        expect(parseUrl(url.slice(1))).toEqual({ mode, map, dataset: datasetFor(mode, map), ...DEFAULTS });
      }
    }
  });
});
