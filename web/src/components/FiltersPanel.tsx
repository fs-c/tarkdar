// Filters view of the side panel: the display rules (how things look, and whether and when they show),
// by category, each hideable one with an on/off switch. Pinned rules (from highlights, for
// this raid) come first, then General: they win over the categories below. Within a category, the
// rules higher up win.

import { Plus, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { compileQuery, QUERY_HELP } from "../highlight/query";
import type { LootPrefs } from "../persist/prefs";
import type { ItemCatalog } from "../model/items";
import type { AnyRow } from "../list/rows";
import { CATEGORIES, type Category, HIDEABLE } from "../rules/defaults";
import {
  type RuleStore, type SetPinned, type SetRuleStore, type StoredRule, addRule, categoryChanged, defaultStore, duplicateRule, missingDefaults,
  moveRule, newRuleId, removeRule, resetCategory, restoreDefaults, updateRule,
} from "../rules/store";
import { Button, PanelBody, Segmented, type SegmentedOption } from "../ui";
import { RuleRow } from "./RuleRow";
import s from "./FiltersPanel.module.css";
import type { SetStored } from "../persist";

interface Props {
  rules: RuleStore;
  setRules: SetRuleStore;
  pinned: StoredRule[];
  setPinned: SetPinned;
  /** Rule id → what it matches now. */
  matched: ReadonlyMap<string, AnyRow[]>;
  catalog: ItemCatalog;
  /** The rule whose matches to mark on the map (null: none). */
  onHoverRule: (id: string | null) => void;
  loot: LootPrefs;
  onLoot: SetStored<LootPrefs>;
  /** What the quest item filter knows right now, e.g. "3 quests in progress". */
  questInfo: string;
  /** The query syntax shown (opened from here, or from the highlight search). */
  help: boolean;
  onHelp: (shown: boolean) => void;
}

const HINTS: Record<Category, string> = {
  General: "Across kinds of thing: win over the categories below",
  Players: "By type",
  Loot: "Loose items by value per slot, and quest items",
  Containers: "Containers, airdrops and corpses",
  Exfils: "Extraction points; their colour tells their status",
  Explosives: "Grenades and tripwires",
  Vehicles: "The BTR",
};

/** Shown top to bottom: what wins first. */
const SHOWN_CATEGORIES = [...CATEGORIES].reverse();

const QUEST_ITEM_OPTIONS: SegmentedOption<LootPrefs["questItems"]>[] = [
  { value: "needed", label: "Needed", title: "Only quest items a started quest still needs to find" },
  { value: "all", label: "All", title: "Every quest item on the map" },
];

export function FiltersPanel(p: Props) {
  const { rules, setRules, pinned, setPinned } = p;
  // One rule's editor open at a time.
  const [open, setOpen] = useState<string | null>(null);
  const { help, onHelp } = p;
  const helpRef = useRef<HTMLDListElement>(null);
  useEffect(() => {
    if (help) helpRef.current?.scrollIntoView({ block: "nearest" });
  }, [help]);
  const opener = (id: string) => (o: boolean) => setOpen(o ? id : null);
  const setList = (update: (rs: StoredRule[]) => StoredRule[]) => setRules((r) => ({ ...r, rules: update(r.rules) }));

  const toggleCategory = (c: Category) =>
    setRules((r) => ({ ...r, hidden: r.hidden.includes(c) ? r.hidden.filter((x) => x !== c) : [...r.hidden, c] }));
  const add = (category: Category) => {
    const id = newRuleId();
    setList((rs) => addRule(rs, { id, category, label: "New rule", query: "", style: {}, on: true }));
    setOpen(id);
  };
  const keep = (r: StoredRule) => {
    setPinned((ps) => removeRule(ps, r.id));
    setList((rs) => addRule(rs, { ...r, id: newRuleId() }));
  };
  const missing = missingDefaults(rules.rules);
  const reset = (c: Category) => {
    const own = rules.rules.filter((r) => r.category === c && !r.origin).length;
    const lose = own ? ` Your ${own} own rule${own === 1 ? "" : "s"} in it will be removed.` : "";
    if (window.confirm(`Reset ${c} to the default rules?${lose}`)) setList((rs) => resetCategory(rs, c));
  };

  const row = (r: StoredRule, pinnedRule: boolean) => {
    const set = pinnedRule ? setPinned : setList;
    return (
      <RuleRow
        key={r.id}
        rule={r}
        open={open === r.id}
        onOpen={opener(r.id)}
        count={p.matched.get(r.id)?.length ?? 0}
        errors={compileQuery(r.query, p.catalog).errors}
        onHover={(on) => p.onHoverRule(on ? r.id : null)}
        onChange={(patch) => set((rs) => updateRule(rs, r.id, patch))}
        onMove={(dir) => set((rs) => moveRule(rs, r.id, dir, !pinnedRule))}
        onDuplicate={() => set((rs) => duplicateRule(rs, r.id))}
        onRemove={() => {
          p.onHoverRule(null);
          set((rs) => removeRule(rs, r.id));
        }}
        onKeep={pinnedRule ? () => keep(r) : undefined}
      />
    );
  };

  return (
    <PanelBody>
      <section className={s.group}>
        <header className={s.header}>
          <h3 className={s.title}>Pinned</h3>
          <small className={s.hint}>This raid only; win over everything below</small>
        </header>
        {pinned.length === 0 && <p className={s.empty}>Pin a highlight (📌 on its pill) to keep it here for this raid.</p>}
        {[...pinned].reverse().map((r) => row(r, true))}
      </section>
      {SHOWN_CATEGORIES.map((group) => {
        const hideable = group in HIDEABLE;
        const shown = !rules.hidden.includes(group);
        const list = rules.rules.filter((r) => r.category === group).reverse();
        return (
          <section key={group} className={s.group} data-off={!shown}>
            <header className={s.header}>
              {hideable ? (
                <label className={s.switchLabel} title={shown ? "Shown: click to hide all of them (ringed things, e.g. highlights, still show)" : "Hidden: click to show"}>
                  <input type="checkbox" role="switch" className={s.switch} checked={shown} onChange={() => toggleCategory(group)} />
                  <h3 className={s.title}>{group}</h3>
                </label>
              ) : (
                <h3 className={s.title}>{group}</h3>
              )}
              <small className={s.hint}>{HINTS[group]}</small>
              {shown && (
                <span className={s.headerActions}>
                  {categoryChanged(rules.rules, group) && (
                    <Button variant="icon" title={`Changed: reset ${group} to the defaults`} onClick={() => reset(group)}>
                      <RotateCcw size={13} />
                    </Button>
                  )}
                  <Button variant="icon" title={`Add a rule to ${group}`} onClick={() => add(group)}>
                    <Plus size={14} />
                  </Button>
                </span>
              )}
            </header>
            {shown && list.length === 0 && <p className={s.empty}>No rules.</p>}
            {shown && list.map((r) => row(r, false))}
            {shown && group === "Loot" && (
              <div className={s.field}>
                <span className={s.caption}>Quest items · {p.questInfo}</span>
                <Segmented<LootPrefs["questItems"]>
                  label="Quest items"
                  title="Quest items: only those a quest in progress still needs, or all of them"
                  options={QUEST_ITEM_OPTIONS}
                  value={p.loot.questItems === "all" ? "all" : "needed"}
                  onChange={(v) => p.onLoot((l) => ({ ...l, questItems: v }))}
                />
              </div>
            )}
          </section>
        );
      })}
      <section className={s.group}>
        <div className={s.ruleActions}>
          <Button variant="link" onClick={() => onHelp(!help)} aria-expanded={help}>
            Query syntax
          </Button>
          {missing > 0 && (
            <Button variant="link" title="Put the default rules you removed back" onClick={() => setList(restoreDefaults)}>
              Restore {missing} default{missing === 1 ? "" : "s"}
            </Button>
          )}
          <Button
            variant="link"
            title="All rules back to the defaults (your own rules go)"
            onClick={() => {
              if (window.confirm("Reset all rules to the defaults? Your own rules will be removed.")) setRules(() => defaultStore());
            }}
          >
            Reset all
          </Button>
        </div>
        {help && (
          <dl ref={helpRef} className={s.help}>
            <dt><code>words "a phrase"</code></dt>
            <dd>text, as in the list's search</dd>
            {QUERY_HELP.map((h) => (
              <div key={h.example}>
                <dt><code>{h.example}</code></dt>
                <dd>{h.text}</dd>
              </div>
            ))}
            <dd className={s.helpNote}>Spaces: all must hold. Commas: any of them (<code>is:boss,raider</code>). Quotes for names with spaces. Compare with &gt;= &gt; &lt;= &lt; =.</dd>
          </dl>
        )}
      </section>
    </PanelBody>
  );
}
