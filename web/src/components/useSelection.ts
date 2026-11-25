import { useMemo, useState } from "react";
import type { RadarState } from "../stream/connection";
import type { ItemCatalog } from "../model/items";
import type { AnyRow, SubjectKind } from "../list/rows";
import { type Selection, selectedPosition, selectionKey } from "../draw/pick";
import { describeEvent } from "../stream/events";
import type { Playback } from "../stream/playback";
import type { Timeline, TimelineEvent } from "../stream/timeline";
import { type Rule, explainStyle } from "../rules/rules";

interface Options {
  /** What's shown (a live raid, or a recording): ids restart every raid, so a selection belongs to one. */
  raid: string;
  state: RadarState;
  everything: readonly AnyRow[];
  rules: readonly Rule[];
  catalog: ItemCatalog;
  hidden: ReadonlySet<SubjectKind>;
  timeline: Timeline | null;
  playback: Playback;
  /** Brings a world position into view (and stops following). */
  centerOn: (pos: [number, number, number] | null) => void;
}

/** The selected thing (map marker or list row), and the ways of selecting one. */
export function useSelection({ raid, state, everything, rules, catalog, hidden, timeline, playback, centerOn }: Options) {
  // Ids restart every raid: a selection from another raid (or recording) would point at something else.
  const [picked, setPicked] = useState<{ raid: string | null; sel: Selection | null }>({ raid: null, sel: null });
  const selection = picked.raid === raid ? picked.sel : null;
  // Why the selected thing looks the way it does (the details panel).
  const selectedRow = useMemo(() => (selection ? everything.find((r) => r.key === selectionKey(selection)) : undefined), [selection, everything]);
  const selectedLook = useMemo(() => (selectedRow ? explainStyle(selectedRow, rules, catalog, hidden) : null), [selectedRow, rules, catalog, hidden]);
  const select = (sel: Selection | null) => setPicked({ raid, sel });
  const clear = () => setPicked((p) => ({ ...p, sel: null }));

  /** Selects something and brings it into view: centred. */
  const showOnMap = (sel: Selection) => {
    select(sel);
    centerOn(selectedPosition(sel, state));
  };

  /** Shows an event: its moment, its subject selected and centred. */
  const pickEvent = (e: TimelineEvent) => {
    if (!timeline) return;
    const d = describeEvent(e, timeline, catalog);
    playback.seek(d.showAt);
    select(d.sel);
    centerOn(d.pos);
  };

  return { selection, selectedRow, selectedLook, select, clear, showOnMap, pickEvent };
}
