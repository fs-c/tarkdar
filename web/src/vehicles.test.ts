import { describe, expect, it } from "vitest";
import type { Player, Vehicle } from "./protocol";
import { gunnerIds, vehicleOf, withoutGunners } from "./vehicles";

const player = (id: number): Player => ({ id, local: false, ai: true, side: "savage", dead: false, absent: false, pos: [0, 0, 0], yaw: 0, pitch: 0 });
const btr: Vehicle = {
  id: 1, kind: "btr", state: 2, pos: [0, 0, 0], yaw: 0,
  occupants: [{ player: 2, seat: "gunner" }, { player: 3, seat: "passenger" }],
};

describe("vehicles", () => {
  it("leaves gunners out of the players", () => {
    expect([...gunnerIds([btr])]).toEqual([2]);
    const state = { players: [player(1), player(2), player(3)], vehicles: [btr] };
    expect(withoutGunners(state).players.map((p) => p.id)).toEqual([1, 3]);
    const none = { players: [player(1)], vehicles: [] };
    expect(withoutGunners(none)).toBe(none);
  });

  it("finds the vehicle a passenger rides in", () => {
    expect(vehicleOf([btr], 3)).toBe(btr);
    expect(vehicleOf([btr], 2)).toBeNull();  // the gunner isn't a passenger
    expect(vehicleOf([btr], 1)).toBeNull();
  });
});
