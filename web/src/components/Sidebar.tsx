// VS Code-style navigation: an always-visible activity bar of icons on the left, and a collapsible
// side panel showing the picked view. Clicking the active icon collapses the panel.

import { Archive, DoorOpen, Funnel, History, type LucideIcon, Map as MapIcon, Package, PanelLeftClose, Settings, Users } from "lucide-react";
import { type PointerEvent, type ReactNode, useRef } from "react";
import { DEFAULT_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, useSidebarSize } from "../prefs";
import { TABS } from "../list/columns";
import type { TabId } from "../list/rows";
import { Button, cx } from "../ui";
import s from "./Sidebar.module.css";

/** The panel's views: one per list tab, plus the display rules, map options, raid recordings, and settings (with debugging). */
export type ViewId = TabId | "filters" | "map" | "raids" | "settings";

const LIST_ICONS: Record<TabId, LucideIcon> = {
  players: Users,
  items: Package,
  containers: Archive,
  exfils: DoorOpen,
};

const TOP: ViewId[] = ["players", "items", "containers", "exfils", "filters", "map", "raids"];

export const VIEW_TITLES: Record<ViewId, string> = {
  ...Object.fromEntries(Object.entries(TABS).map(([id, t]) => [id, t.label])),
  filters: "Filters",
  map: "Map",
  raids: "Raids",
  settings: "Settings",
} as Record<ViewId, string>;

const ICONS: Record<ViewId, LucideIcon> = { ...LIST_ICONS, filters: Funnel, map: MapIcon, raids: History, settings: Settings };

interface ActivityBarProps {
  /** The view shown in the panel, or null when it's collapsed. */
  active: ViewId | null;
  onPick: (view: ViewId) => void;
  /** Badge per view: a number (row count), true (a dot), or nothing. */
  badges: Partial<Record<ViewId, number | boolean>>;
}

export function ActivityBar({ active, onPick, badges }: ActivityBarProps) {
  const item = (v: ViewId) => {
    const Icon = ICONS[v];
    const badge = badges[v];
    return (
      <button
        key={v}
        className={s.activity}
        aria-pressed={v === active}
        title={VIEW_TITLES[v] + (v === active ? " (click to collapse)" : "")}
        onClick={() => onPick(v)}
      >
        <Icon size={22} strokeWidth={1.6} />
        {typeof badge === "number" && badge > 0 && <span className={s.badge}>{compact(badge)}</span>}
        {badge === true && <span className={cx(s.badge, s.dot)} />}
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
        <Button variant="icon" title="Collapse (L)" onClick={onClose}>
          <PanelLeftClose size={16} />
        </Button>
      </header>
      {children}
    </aside>
  );
}
