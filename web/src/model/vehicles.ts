import type { Player, Vehicle } from "./protocol";

/** Ids of the players on a vehicle's turret (the BTR gunner): not shown as players. */
export function gunnerIds(vehicles: readonly Vehicle[]): Set<number> {
  const ids = new Set<number>();
  for (const v of vehicles) for (const o of v.occupants) if (o.seat === "gunner") ids.add(o.player);
  return ids;
}

/** The state with vehicle gunners left out of its players (unchanged if there are none). */
export function withoutGunners<T extends { players: Player[]; vehicles: Vehicle[] }>(state: T): T {
  const gunners = gunnerIds(state.vehicles);
  return gunners.size ? { ...state, players: state.players.filter((p) => !gunners.has(p.id)) } : state;
}

/** The vehicle a player rides in as a passenger, if any. */
export function vehicleOf(vehicles: readonly Vehicle[], playerId: number): Vehicle | null {
  return vehicles.find((v) => v.occupants.some((o) => o.player === playerId && o.seat === "passenger")) ?? null;
}
