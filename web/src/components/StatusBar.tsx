import type { CatalogStatus } from "../catalog";
import type { RadarState } from "../connection";
import { cx } from "../ui";
import s from "./StatusBar.module.css";

const STATE_LABELS: Record<string, string> = {
  waitingForProcess: "waiting for the game",
  waitingForModules: "game starting",
  inRaid: "in raid",
  cooldown: "raid ended",
};

export function statusParts(
  s: RadarState,
  /** The shown map's name (null: none for this location). */
  map: string | null,
  catalog: CatalogStatus,
  /** Replaying a recording: its name ("Customs · 10 Nov 19:03"). */
  replay: string | null = null,
): string[] {
  if (!s.connected) return ["⚠ disconnected from backend"];
  if (s.protocolMismatch) return ["⚠ protocol version mismatch: rebuild the frontend"];
  if (!s.status) return [s.live ? "connected" : "offline: no game, recorded raids only"];
  const parts: string[] = [];
  const { state } = s.status;
  if (replay) parts.push(`replay: ${replay}`);
  else if (state === "waitingForRaid") parts.push(s.status.raidPending ? "raid loading…" : "waiting for a raid");
  else if (state === "inRaid") parts.push(`in raid: ${s.status.locationId ?? "?"}`);
  else parts.push(STATE_LABELS[state] ?? state);
  if (state === "inRaid") {
    parts.push(map ?? "no map for this location");
    const alive = s.players.filter((p) => !p.dead && !p.absent).length;
    parts.push(`${alive} alive / ${s.players.length} players`);
    if (s.loot.length) parts.push(`${s.loot.length} loot`);
  }
  if (s.status.offsetsMismatch) parts.push("⚠ game build differs from the offsets' build");
  if (catalog.state === "unavailable") parts.push("⚠ no item data");
  else if (catalog.state === "stale") parts.push("item data stale");
  return parts;
}

interface Props {
  state: RadarState;
  map: string | null;
  catalog: CatalogStatus;
  /** Replaying a recording: its name. */
  replay?: string | null;
  /** Extra items on the right. */
  children?: React.ReactNode;
}

export function StatusBar({ state, map, catalog, replay = null, children }: Props) {
  const parts = statusParts(state, map, catalog, replay);
  const warn = !state.connected || state.protocolMismatch;
  return (
    <footer className={s.bar} data-mode={warn ? "warn" : undefined}>
      {parts.map((p, i) => (
        <StatusText key={i} alert={p.startsWith("⚠")}>{p}</StatusText>
      ))}
      <span className={s.spacer} />
      {children}
    </footer>
  );
}

/** A piece of status text; consecutive ones are separated by a rule. */
export function StatusText({ alert = false, children }: { alert?: boolean; children: React.ReactNode }) {
  return <span className={cx(s.item, s.text, alert && s.alert)}>{children}</span>;
}

interface StatusButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** warn: something's off; link: a way to a view. */
  tone?: "warn" | "link";
}

/** A clickable status bar item. */
export function StatusButton({ tone, className, ...rest }: StatusButtonProps) {
  return <button type="button" className={cx(s.item, s.button, className)} data-tone={tone} {...rest} />;
}
