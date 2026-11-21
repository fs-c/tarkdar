import { describe, expect, it } from "vitest";
import { slotValue } from "./items";

describe("slotValue", () => {
  it("divides the price by the slots the item takes; unpriced: unknown", () => {
    expect(slotValue({ name: "", shortName: "", price: 90_000, slots: 6 })).toBe(15_000);
    expect(slotValue({ name: "", shortName: "", price: 90_000 })).toBe(90_000);
    expect(slotValue({ name: "", shortName: "" })).toBeUndefined();
    expect(slotValue(undefined)).toBeUndefined();
  });
});
