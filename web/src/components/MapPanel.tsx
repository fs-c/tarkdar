// Map view of the side panel: the display rules (how things look, and whether and when they show),
// grouped, each group with an on/off switch where it can be hidden as a whole; then trails.
// Standing rules (pinned highlights) come first: they win over the built-in rules below them.

import { useState } from "react";
import type { LootPrefs, TrailPrefs } from "../hooks";
import type { AnyRow } from "../list/rows";
import { BUILTIN_RULES, HIDEABLE, type RuleGroup } from "../rules/defaults";
import { type RuleEdit, type RuleStore, type SetRuleStore, editedRule } from "../rules/store";
import { PanelBody, Segmented, type SegmentedOption, ToggleRow } from "../ui";
import { RuleRow } from "./RuleRow";
import s from "./MapPanel.module.css";

interface Props {
  rules: RuleStore;
  setRules: SetRuleStore;
  /** Rule id → what it matches now (standing rules). */
  matched: ReadonlyMap<string, AnyRow[]>;
  trails: TrailPrefs;
  onTrails: (t: TrailPrefs) => void;
  loot: LootPrefs;
  onLoot: (l: LootPrefs) => void;
  /** What the quest item filter knows right now, e.g. "3 quests in progress". */
  questInfo: string;
}

const GROUPS: { group: RuleGroup; hint: string }[] = [
  { group: "Players", hint: "By type" },
  { group: "Loot", hint: "Loose items by value, and quest items" },
  { group: "Containers", hint: "Containers, airdrops and corpses" },
  { group: "Exfils", hint: "Extraction points; their colour tells their status" },
  { group: "Explosives", hint: "Grenades and tripwires" },
];

const QUEST_ITEM_OPTIONS: SegmentedOption<LootPrefs["questItems"]>[] = [
  { value: "needed", label: "Needed", title: "Only quest items a started quest still needs to find" },
  { value: "all", label: "All", title: "Every quest item on the map" },
];

const TRAIL_LENGTHS: (number | null)[] = [0.5, 1, 2, 5, 10, 15, 30, null];

export function MapPanel(p: Props) {
  const { rules, setRules } = p;
  // One rule's editor open at a time.
  const [open, setOpen] = useState<string | null>(null);
  const opener = (id: string) => (o: boolean) => setOpen(o ? id : null);

  const edit = (id: string, patch: RuleEdit) => setRules((r) => ({ ...r, edits: { ...r.edits, [id]: { ...r.edits[id], ...patch } } }));
  const reset = (id: string) =>
    setRules((r) => {
      const { [id]: _, ...edits } = r.edits;
      return { ...r, edits };
    });
  const toggleGroup = (g: RuleGroup) =>
    setRules((r) => ({ ...r, hidden: r.hidden.includes(g) ? r.hidden.filter((x) => x !== g) : [...r.hidden, g] }));
  const updateMine = (id: string, update: (m: RuleStore["mine"][number]) => RuleStore["mine"][number] | null) =>
    setRules((r) => ({ ...r, mine: r.mine.flatMap((m) => (m.id === id ? (update(m) ?? []) : [m])) }));
  const moveMine = (id: string, dir: -1 | 1) =>
    setRules((r) => {
      const i = r.mine.findIndex((m) => m.id === id), j = i + dir;
      if (i < 0 || j < 0 || j >= r.mine.length) return r;
      const mine = [...r.mine];
      [mine[i], mine[j]] = [mine[j]!, mine[i]!];
      return { ...r, mine };
    });

  return (
    <PanelBody>
      <section className={s.group}>
        <header className={s.header}>
          <h3 className={s.title}>Mine</h3>
          <small className={s.hint}>Win over everything below</small>
        </header>
        {rules.mine.length === 0 && <p className={s.empty}>Pin a highlight (📌 on its pill) to keep it here as a standing rule.</p>}
        {/* Top to bottom: the last one wins. */}
        {[...rules.mine].reverse().map((m) => (
          <RuleRow
            key={m.id}
            rule={{ ...m, on: m.on }}
            kind={m.kind}
            open={open === m.id}
            onOpen={opener(m.id)}
            count={p.matched.get(m.id)?.length ?? 0}
            onEdit={(patch) => updateMine(m.id, (x) => ({ ...x, style: { ...x.style, ...patch } }))}
            onToggle={() => updateMine(m.id, (x) => ({ ...x, on: !x.on }))}
            onMove={(dir) => moveMine(m.id, dir)}
            onRemove={() => updateMine(m.id, () => null)}
          />
        ))}
      </section>
      {GROUPS.map(({ group, hint }) => {
        const hideable = group in HIDEABLE;
        const shown = !rules.hidden.includes(group);
        return (
          <section key={group} className={s.group} data-off={!shown}>
            <header className={s.header}>
              {hideable ? (
                <label className={s.switchLabel} title={shown ? "Shown: click to hide all of them (highlights and your rules still show)" : "Hidden: click to show"}>
                  <input type="checkbox" role="switch" className={s.switch} checked={shown} onChange={() => toggleGroup(group)} />
                  <h3 className={s.title}>{group}</h3>
                </label>
              ) : (
                <h3 className={s.title}>{group}</h3>
              )}
              <small className={s.hint}>{hint}</small>
            </header>
            {shown &&
              BUILTIN_RULES.filter((r) => r.group === group).map((r) => (
                <RuleRow
                  key={r.id}
                  rule={editedRule(r, rules.edits[r.id])}
                  open={open === r.id}
                  onOpen={opener(r.id)}
                  onEdit={(patch) => edit(r.id, patch)}
                  onReset={rules.edits[r.id] ? () => reset(r.id) : undefined}
                />
              ))}
            {shown && group === "Loot" && (
              <div className={s.field}>
                <span className={s.caption}>Quest items · {p.questInfo}</span>
                <Segmented<LootPrefs["questItems"]>
                  label="Quest items"
                  title="Quest items: only those a quest in progress still needs, or all of them"
                  options={QUEST_ITEM_OPTIONS}
                  value={p.loot.questItems === "all" ? "all" : "needed"}
                  onChange={(v) => p.onLoot({ ...p.loot, questItems: v })}
                />
              </div>
            )}
          </section>
        );
      })}
      <section className={s.group}>
        <header className={s.header}>
          <h3 className={s.title}>Trails</h3>
        </header>
        <div className={s.inset}>
          <ToggleRow
            label="Selected player"
            hint="Where they've been this raid"
            checked={p.trails.selected}
            onChange={() => p.onTrails({ ...p.trails, selected: !p.trails.selected })}
          />
          <ToggleRow
            label="Everyone"
            hint="Recent paths of all players (those the list's filters let through)"
            checked={p.trails.all}
            onChange={() => p.onTrails({ ...p.trails, all: !p.trails.all })}
          />
          {p.trails.all && (
            <Segmented
              label="Trail duration"
              title="How far back everyone's trails reach (the selected player's always shows the whole raid)"
              options={TRAIL_LENGTHS.map((m) => ({ value: m, label: m === null ? "Whole raid" : m < 1 ? `${m * 60} s` : `${m} min` }))}
              value={p.trails.minutes}
              onChange={(m) => p.onTrails({ ...p.trails, minutes: m })}
            />
          )}
        </div>
      </section>
    </PanelBody>
  );
}
