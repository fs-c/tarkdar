// Navigation: one frosted card floating over the map's left edge (SidebarCard), with an
// always-visible rail of icons and a collapsible panel showing the picked view. Clicking the active
// icon collapses the panel; it unfolds and folds away (the card's edge, and with it the map's middle,
// moving along). Switching views, the rail's accent mark slides to the new icon and the view slides in.

import { Binoculars, ChevronLeft, DoorOpen, History, type LucideIcon, Package, Settings, Users } from "lucide-react";
import { type PointerEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
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
  const navRef = useRef<HTMLElement>(null);
  const markRef = useRef<HTMLSpanElement>(null);
  // The accent mark beside the active icon: one for the rail, so it slides from icon to icon (and
  // keeps its place while the panel is folded, popping in there again).
  const placed = useRef(false);
  useLayoutEffect(() => {
    const nav = navRef.current!, mark = markRef.current!;
    const place = () => {
      const button = active && nav.querySelector<HTMLElement>(`[data-view="${active}"]`);
      const top = button ? `${button.offsetTop + MARK_INSET}px` : mark.style.top;
      // The first time, straight there (popping in still): no sliding down from the rail's top.
      if (!placed.current) mark.style.transition = "transform 0.2s ease, opacity 0.2s ease";
      mark.dataset.on = String(!!button);
      mark.style.top = top;
      if (!placed.current) {
        void mark.offsetTop; // the place without transition, before it's turned back on
        mark.style.transition = "";
        placed.current = !!button;
      }
    };
    place();
    const observer = new ResizeObserver(place); // the settings icon moves with the window's height
    observer.observe(nav);
    return () => observer.disconnect();
  }, [active]);

  const item = (v: ViewId) => {
    const Icon = ICONS[v];
    const badge = badges[v];
    return (
      <button
        key={v}
        data-view={v}
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
    <nav ref={navRef} className={s.activityBar}>
      <span ref={markRef} className={s.mark} />
      {TOP.map(item)}
      <div className={s.spacer} />
      {item("settings")}
    </nav>
  );
}

/** The accent mark's distance from its icon's top and bottom edges (px). */
const MARK_INSET = 11;

function compact(n: number): string {
  return n > 999 ? `${Math.floor(n / 1000)}k` : String(n);
}

interface SidePanelProps {
  /** Unfolded; folded, the panel takes no room (but stays on screen while it folds away). */
  open: boolean;
  view: ViewId;
  onClose: () => void;
  children: ReactNode;
}

/** Panel width in px: the same for every view, dragged with the sash on its right edge. */
const MIN_WIDTH = MIN_SIDEBAR_WIDTH;
/** Room always left for the map. */
const MAP_MIN = 160;
/** The rail's order, top to bottom. */
const ORDER: ViewId[] = [...TOP, "settings"];
/** Switching views: the new one comes in quickly and settles. */
const SETTLE = "cubic-bezier(0.2, 0.8, 0.3, 1)";

export function SidePanel({ open, view, onClose, children }: SidePanelProps) {
  const [{ width }, setSize] = useSidebarSize();
  const drag = useRef<{ x: number; width: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  // On screen: unfolded, or still folding away.
  const [shown, setShown] = useState(open);
  if (open && !shown) setShown(true);
  useEffect(() => {
    if (open) return;
    // Gone once folded (at once without motion). Unfolded again before that: it stays.
    let live = true;
    Promise.all(drawerRef.current!.getAnimations().map((a) => a.finished)).then(
      () => live && setShown(false),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [open]);

  // Switching views: the new one slides in from the side of the rail its icon is on (below, above).
  // Not as it unfolds: that's motion enough.
  const last = useRef({ view, open });
  useLayoutEffect(() => {
    const { view: from, open: wasOpen } = last.current;
    last.current = { view, open };
    const panel = panelRef.current;
    if (from === view || !wasOpen || !open || !panel || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const dir = Math.sign(ORDER.indexOf(view) - ORDER.indexOf(from));
    const [header, ...body] = panel.children;
    header?.querySelector("h2")?.animate([{ opacity: 0, transform: `translateY(${dir * 6}px)` }, {}], { duration: 200, easing: SETTLE });
    for (const el of body) el.animate([{ opacity: 0, transform: `translateY(${dir * 10}px)` }, {}], { duration: 240, delay: 30, easing: SETTLE, fill: "backwards" });
  }, [view, open]);

  const onSashDown = (e: PointerEvent) => {
    drag.current = { x: e.clientX, width: panelRef.current?.offsetWidth ?? width };
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onSashMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const left = panelRef.current?.getBoundingClientRect().left ?? 0;
    const max = window.innerWidth - left - MAP_MIN;
    setSize({ width: Math.round(Math.max(MIN_WIDTH, Math.min(max, d.width + e.clientX - d.x))) });
  };
  const onSashUp = () => {
    drag.current = null;
    setDragging(false);
  };

  // The drawer clips the panel, which keeps its width: folding, the view slides away instead of squeezing.
  return (
    <>
      <div ref={drawerRef} className={s.drawer} data-dragging={dragging} style={{ width: open ? width : 0 }}>
        {shown && (
          <aside ref={panelRef} className={s.sidebar} style={{ width }} inert={!open}>
            <header className={s.header}>
              <h2 className={s.title}>{VIEW_TITLES[view]}</h2>
              <Button variant="icon" title="Fold the panel" onClick={onClose}>
                <ChevronLeft size={16} />
              </Button>
            </header>
            {children}
          </aside>
        )}
      </div>
      {open && (
        <div
          className={s.sash}
          role="separator"
          aria-orientation="vertical"
          title="Drag to resize, double-click to reset"
          onPointerDown={onSashDown}
          onPointerMove={onSashMove}
          onPointerUp={onSashUp}
          onPointerCancel={onSashUp}
          onDoubleClick={() => setSize({ width: DEFAULT_SIDEBAR_WIDTH })}
        />
      )}
    </>
  );
}
