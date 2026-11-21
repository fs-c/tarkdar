import type { CatalogStatus } from "../model/catalog";
import type { RadarState } from "../stream/connection";
import { cx } from "../ui";
import s from "./StatusBar.module.css";

const STATE_LABELS: Record<string, string> = {
  waitingForProcess: "waiting for the game",
  waitingForModules: "game starting",
  inRaid: "in raid",
  cooldown: "raid ended",
};

type StatusPart = { text: string; alert?: boolean };

function statusParts(
  state: RadarState,
  /** The shown map's name (null: none for this location). */
  map: string | null,
  catalog: CatalogStatus,
  /** Replaying a recording: its name ("Customs · 10 Nov 19:03"). */
  replay: string | null = null,
): StatusPart[] {
  if (!state.connected) return [{ text: "⚠ disconnected from backend", alert: true }];
  if (state.protocolMismatch) return [{ text: "⚠ protocol version mismatch: rebuild the frontend", alert: true }];
  const { status } = state;
  if (!status) return [{ text: state.live ? "connected" : "offline: no game, recorded raids only" }];
  const parts: StatusPart[] = [];
  const phase = status.state;
  if (replay) parts.push({ text: `replay: ${replay}` });
  else if (phase === "waitingForRaid") parts.push({ text: status.raidPending ? "raid loading…" : "waiting for a raid" });
  else if (phase === "inRaid") parts.push({ text: `in raid: ${status.locationId ?? "?"}` });
  else parts.push({ text: STATE_LABELS[phase] ?? phase });
  if (phase === "inRaid") {
    parts.push({ text: map ?? "no map for this location" });
    const alive = state.players.filter((p) => !p.dead && !p.absent).length;
    parts.push({ text: `${alive} alive / ${state.players.length} players` });
    if (state.loot.length) parts.push({ text: `${state.loot.length} loot` });
  }
  if (status.offsetsMismatch) parts.push({ text: "⚠ game build differs from the offsets' build", alert: true });
  if (catalog.state === "unavailable") parts.push({ text: "⚠ no item data", alert: true });
  else if (catalog.state === "stale") parts.push({ text: "item data stale" });
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
        <StatusText key={i} alert={p.alert}>{p.text}</StatusText>
      ))}
      <span className={s.spacer} />
      {children}
    </footer>
  );
}

/** A piece of status text; consecutive ones are separated by a rule. */
function StatusText({ alert = false, children }: { alert?: boolean; children: React.ReactNode }) {
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
