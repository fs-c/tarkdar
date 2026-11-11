import { describe, expect, it } from "vitest";
import { VALUE_TIERS, valueTier } from "./items";

describe("valueTier", () => {
  it("buckets by price, with unpriced items as low", () => {
    expect(valueTier(undefined)).toBe("low");
    expect(valueTier(VALUE_TIERS.mid - 1)).toBe("low");
    expect(valueTier(VALUE_TIERS.mid)).toBe("mid");
    expect(valueTier(VALUE_TIERS.high - 1)).toBe("mid");
    expect(valueTier(VALUE_TIERS.high)).toBe("high");
  });
});
