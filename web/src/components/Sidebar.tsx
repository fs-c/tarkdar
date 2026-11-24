// Navigation: one frosted card floating over the map's left edge (SidebarCard), with an
// always-visible rail of icons and a collapsible panel showing the picked view. Clicking the active
// icon collapses the panel.

import { Binoculars, ChevronLeft, DoorOpen, History, type LucideIcon, Package, Settings, Users } from "lucide-react";
import { type PointerEvent, type ReactNode, useLayoutEffect, useRef } from "react";
import { DEFAULT_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, useSidebarSize } from "../persist/prefs";
import type { Section } from "../persist/prefs";
import { Button, cx } from "../ui";
import s from "./Sidebar.module.css";

/** The panel's views: who's around, loot, exfils, the watchlist (with tracked quests), raids, settings. */
export type ViewId = Section;

const TOP: ViewId[] = ["players", "loot", "exfils", "watch", "raids"];

export const VIEW_TITLES: Record<ViewId, string> = { players: "Players", loot: "Loot", exfils: "Exfils", watch: "Watch", raids: "Raids", settings: "Settings" };

const ICONS: Record<ViewId, LucideIcon> = { players: Users, loot: Package, exfils: DoorOpen, watch: Binoculars, raids: History, settings: Settings };

/** A rail icon's badge: a count; a count that wants attention ("new"); or a dot (live: red, else amber). */
export type Badge = number | { n: number; tone: "new" } | { dot: "live" | "warn" };

/** The card around the rail and the panel. Reports how far it reaches into the map (its right edge,
 *  px from the window's left), which is where the map's own controls start. */
export function SidebarCard({ onCover, children }: { onCover: (px: number) => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current!;
    const report = () => onCover(Math.round(el.getBoundingClientRect().right));
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    addEventListener("resize", report);
    return () => {
      observer.disconnect();
      removeEventListener("resize", report);
    };
  }, [onCover]);
  return (
    <div ref={ref} className={s.card}>
      {children}
    </div>
  );
}

interface ActivityBarProps {
  /** The view shown in the panel, or null when it's collapsed. */
  active: ViewId | null;
  onPick: (view: ViewId) => void;
  badges: Partial<Record<ViewId, Badge>>;
  /** Extra tooltip text per view ("a raid is live"). */
  notes?: Partial<Record<ViewId, string>>;
}

export function ActivityBar({ active, onPick, badges, notes = {} }: ActivityBarProps) {
  const item = (v: ViewId) => {
    const Icon = ICONS[v];
    const badge = badges[v];
    return (
      <button
        key={v}
        className={s.activity}
        aria-pressed={v === active}
        title={VIEW_TITLES[v] + (notes[v] ? ` · ${notes[v]}` : "") + (v === active ? " (click to fold)" : "")}
        onClick={() => onPick(v)}
      >
        <Icon size={22} strokeWidth={1.7} />
        {typeof badge === "number" && badge > 0 && <span className={s.badge}>{compact(badge)}</span>}
        {typeof badge === "object" && "n" in badge && badge.n > 0 && <span className={cx(s.badge, s.new)}>{compact(badge.n)}</span>}
        {typeof badge === "object" && "dot" in badge && <span className={cx(s.badge, s.dot)} data-tone={badge.dot} />}
      </button>
    );
  };
  return (
    <nav className={s.activityBar}>
      {TOP.map(item)}
      <div className={s.spacer} />
      {item("settings")}
    </nav>
  );
}

function compact(n: number): string {
  return n > 999 ? `${Math.floor(n / 1000)}k` : String(n);
}

interface SidePanelProps {
  view: ViewId;
  onClose: () => void;
  children: ReactNode;
}

/** Panel width in px: the same for every view, dragged with the sash on its right edge. */
const MIN_WIDTH = MIN_SIDEBAR_WIDTH;
/** Room always left for the map. */
const MAP_MIN = 160;

export function SidePanel({ view, onClose, children }: SidePanelProps) {
  const [{ width }, setSize] = useSidebarSize();
  const drag = useRef<{ x: number; width: number } | null>(null);
  const panelRef = useRef<HTMLElement>(null);

  const onSashDown = (e: PointerEvent) => {
    drag.current = { x: e.clientX, width: panelRef.current?.offsetWidth ?? width };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onSashMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const left = panelRef.current?.getBoundingClientRect().left ?? 0;
    const max = window.innerWidth - left - MAP_MIN;
    setSize({ width: Math.round(Math.max(MIN_WIDTH, Math.min(max, d.width + e.clientX - d.x))) });
  };

  return (
    <aside ref={panelRef} className={s.sidebar} style={{ width }}>
      <div
        className={s.sash}
        role="separator"
        aria-orientation="vertical"
        title="Drag to resize, double-click to reset"
        onPointerDown={onSashDown}
        onPointerMove={onSashMove}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
        onDoubleClick={() => setSize({ width: DEFAULT_SIDEBAR_WIDTH })}
      />
      <header className={s.header}>
        <h2 className={s.title}>{VIEW_TITLES[view]}</h2>
        <Button variant="icon" title="Fold the panel" onClick={onClose}>
          <ChevronLeft size={16} />
        </Button>
      </header>
      {children}
    </aside>
  );
}
