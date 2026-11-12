import { describe, expect, it } from "vitest";
import { darken } from "./render";

describe("darken", () => {
  it("mixes #rrggbb towards black, leaves other formats alone", () => {
    expect(darken("#ff8000", 0)).toBe("#ff8000");
    expect(darken("#ff8000", 0.5)).toBe("rgb(128, 64, 0)");
    expect(darken("#ff8000", 2)).toBe("rgb(0, 0, 0)");
    expect(darken("rgba(1, 2, 3, 0.5)", 0.5)).toBe("rgba(1, 2, 3, 0.5)");
  });
});
