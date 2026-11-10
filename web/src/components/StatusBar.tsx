import type { CatalogStatus } from "../catalog";
import type { RadarState } from "../connection";
import type { LoadedMap } from "../maps";

const STATE_LABELS: Record<string, string> = {
  waitingForProcess: "waiting for the game",
  waitingForModules: "game starting",
  inRaid: "in raid",
  cooldown: "raid ended",
};

export function statusText(
  s: RadarState,
  map: LoadedMap | null,
  layer: number,
  manualLayer: number | null,
  catalog: CatalogStatus,
): string {
  if (!s.connected) return "⚠ disconnected from backend";
  if (s.protocolMismatch) return "⚠ protocol version mismatch: rebuild the frontend";
  if (!s.status) return "connected";
  const parts: string[] = [];
  const { state } = s.status;
  if (state === "waitingForRaid") parts.push(s.status.raidPending ? "raid loading…" : "waiting for a raid");
  else if (state === "inRaid") parts.push(`in raid: ${s.status.locationId ?? "?"}`);
  else parts.push(STATE_LABELS[state] ?? state);
  if (state === "inRaid") {
    if (!map) parts.push("no map for this location");
    else if (map.config.layers.length > 1)
      parts.push(`${map.config.name}, floor ${layer + 1}/${map.config.layers.length}${manualLayer === null ? " (auto)" : ""}`);
    else parts.push(map.config.name);
    const alive = s.players.filter((p) => !p.dead && !p.absent).length;
    parts.push(`${alive} alive / ${s.players.length} players`);
    if (s.loot.length) parts.push(`${s.loot.length} loot`);
  }
  if (s.status.offsetsMismatch) parts.push("⚠ game build differs from the offsets' build");
  if (catalog.state === "unavailable") parts.push("⚠ no item data");
  else if (catalog.state === "stale") parts.push("item data stale");
  return parts.join(" · ");
}

interface Props {
  state: RadarState;
  map: LoadedMap | null;
  layer: number;
  manualLayer: number | null;
  catalog: CatalogStatus;
}

export function StatusBar({ state, map, layer, manualLayer, catalog }: Props) {
  return <div id="status">{statusText(state, map, layer, manualLayer, catalog)}</div>;
}
