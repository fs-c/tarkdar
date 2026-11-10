// VS Code-style navigation: an always-visible activity bar of icons on the left, and a collapsible
// side panel showing the picked view. Clicking the active icon collapses the panel.

import { Archive, Bomb, DoorOpen, History, Layers, type LucideIcon, Package, PanelLeftClose, Radio, Settings, Users } from "lucide-react";
import type { ReactNode } from "react";
import { TABS } from "../list/columns";
import type { TabId } from "../list/rows";

/** The panel's views: one per list tab, plus map options, raid recordings and settings. */
export type ViewId = TabId | "timeline" | "map" | "raids" | "settings";

export const LIST_ICONS: Record<TabId, LucideIcon> = {
  players: Users,
  items: Package,
  containers: Archive,
  exfils: DoorOpen,
  explosives: Bomb,
};

const TOP: ViewId[] = ["players", "items", "containers", "exfils", "explosives", "timeline", "map"];

export const VIEW_TITLES: Record<ViewId, string> = {
  ...Object.fromEntries(Object.entries(TABS).map(([id, t]) => [id, t.label])),
  timeline: "Timeline",
  map: "Map",
  raids: "Raids",
  settings: "Settings",
} as Record<ViewId, string>;

const ICONS: Record<ViewId, LucideIcon> = { ...LIST_ICONS, timeline: Radio, map: Layers, raids: History, settings: Settings };

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
        className={v === active ? "active" : undefined}
        aria-pressed={v === active}
        title={VIEW_TITLES[v] + (v === active ? " (click to collapse)" : "")}
        onClick={() => onPick(v)}
      >
        <Icon size={22} strokeWidth={1.6} />
        {typeof badge === "number" && badge > 0 && <span className="badge">{compact(badge)}</span>}
        {badge === true && <span className="badge dot" />}
      </button>
    );
  };
  return (
    <nav id="activitybar">
      {TOP.map(item)}
      <div className="spacer" />
      {item("raids")}
      {item("settings")}
    </nav>
  );
}

function compact(n: number): string {
  return n > 999 ? `${Math.floor(n / 1000)}k` : String(n);
}

interface SidePanelProps {
  view: ViewId;
  /** Shown right of the title (e.g. a row count). */
  aside?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}

export function SidePanel({ view, aside, onClose, children }: SidePanelProps) {
  return (
    <aside id="sidebar" className={view === "map" || view === "raids" || view === "settings" ? "narrow" : undefined}>
      <header>
        <h2>{VIEW_TITLES[view]}</h2>
        <span className="aside">{aside}</span>
        <button className="icon" title="Collapse (L)" onClick={onClose}>
          <PanelLeftClose size={16} />
        </button>
      </header>
      {children}
    </aside>
  );
}
