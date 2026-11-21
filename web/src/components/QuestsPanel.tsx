// Quests view of the side panel: the local player's quests in progress, by kind, with the items their
// objectives still need; and quests imported from tarkov.dev that aren't started yet (to collect for
// them already). A switch per quest and per kind says whether it counts. A quest that doesn't count
// needs nothing: its quest items are left out (with Quest items: Needed), and its items aren't
// `is:needed`. For quests left in progress for good, whose markers would only clutter the map.

import { X } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import type { ItemCatalog } from "../model/items";
import type { QuestObjective, QuestState } from "../model/protocol";
import { type NeedKind, QUEST_READY, QUEST_STARTED, counts, openObjectives, questLabel, traderName } from "../model/quests";
import { type ImportedQuest, type TaskFeed, loadTaskFeed } from "../model/taskFeed";
import type { QuestPrefs } from "../persist/prefs";
import type { SetStored } from "../persist";
import { Actions, Button, Note, PanelBody, Section, Switch, TextInput } from "../ui";
import s from "./QuestsPanel.module.css";

interface Props {
  /** The raid's quests (before any filtering); null when they weren't read. */
  quests: readonly QuestState[] | null;
  catalog: ItemCatalog;
  prefs: QuestPrefs;
  onPrefs: SetStored<QuestPrefs>;
  /** What the quest item filter knows right now, e.g. "3 quests started, 5 items needed". */
  questInfo: string;
}

/** Sections, top to bottom. */
const ORDER: NeedKind[] = ["side", "story", "daily", "weekly", "imported"];
const KIND_TITLES: Record<NeedKind, string> = { side: "Quests", story: "Story", daily: "Dailies", weekly: "Weeklies", imported: "Imported" };
const VERBS = { find: "Find", handover: "Hand over", plant: "Plant" } as const;
/** Items listed by name for an objective; more: "any of N items". */
const LISTED_ITEMS = 3;
/** Search results shown when importing. */
const MAX_RESULTS = 15;

const toggled = <T,>(list: readonly T[], x: T): T[] => (list.includes(x) ? list.filter((y) => y !== x) : [...list, x]);

export function QuestsPanel({ quests, catalog, prefs, onPrefs, questInfo }: Props) {
  const counting = { ignored: new Set(prefs.ignored), ignoredKinds: new Set(prefs.ignoredKinds) };
  const toggleQuest = (id: string) => onPrefs((p) => ({ ...p, ignored: toggled(p.ignored, id) }));
  const toggleKind = (k: NeedKind) => onPrefs((p) => ({ ...p, ignoredKinds: toggled(p.ignoredKinds, k) }));
  const shown = (quests ?? []).filter((q) => q.status === QUEST_STARTED || q.status === QUEST_READY);
  const live = new Set(shown.map((q) => q.id));
  const notCounting =
    shown.filter((q) => q.status === QUEST_STARTED && !counts(q.id, q.kind ?? "side", counting)).length +
    prefs.imported.filter((q) => !live.has(q.id) && !counts(q.id, "imported", counting)).length;
  const itemName = (tpl: string, names?: Record<string, string>) => names?.[tpl] ?? catalog.lookup(tpl)?.name ?? tpl;

  const byKind = new Map<NeedKind, QuestState[]>();
  for (const q of shown) {
    const kind = q.kind ?? "side";
    byKind.set(kind, [...(byKind.get(kind) ?? []), q]);
  }

  const kindSwitch = (k: NeedKind) => {
    const on = !counting.ignoredKinds.has(k);
    return <Switch size="sm" checked={on} onChange={() => toggleKind(k)} title={on ? `${KIND_TITLES[k]} count (click: ignore them all)` : `${KIND_TITLES[k]} are ignored (click: count them)`} />;
  };

  return (
    <PanelBody>
      <Section title="Summary">
        <p className="muted">
          {quests ? questInfo : "No quests read (not in a raid, or an older recording)."}
          {notCounting > 0 && ` · ${notCounting} not counting`}
        </p>
        {(notCounting > 0 || prefs.ignoredKinds.length > 0) && (
          <Actions>
            <Button title="Every quest and kind counts again" onClick={() => onPrefs((p) => ({ ...p, ignored: [], ignoredKinds: [] }))}>
              All count
            </Button>
          </Actions>
        )}
      </Section>
      {ORDER.filter((k) => k !== "imported" && byKind.has(k)).map((kind) => {
        const list = [...byKind.get(kind)!].sort((a, b) => questLabel(a).localeCompare(questLabel(b)));
        const kindOn = !counting.ignoredKinds.has(kind);
        return (
          <Section key={kind} title={`${KIND_TITLES[kind]} · ${list.length}`} aside={kindSwitch(kind)}>
            <ul className={s.quests} data-on={kindOn}>
              {list.map((q) => {
                const ready = q.status === QUEST_READY;
                return (
                  <QuestRow
                    key={q.id}
                    id={q.id}
                    label={questLabel(q)}
                    meta={[q.kind !== "story" && q.name ? traderName(q.trader) : undefined, q.hidden ? "hidden step" : undefined]}
                    counts={!counting.ignored.has(q.id)}
                    kindOn={kindOn}
                    ready={ready}
                    onToggle={() => toggleQuest(q.id)}
                  >
                    {ready ? (
                      <div className={s.note}>ready to hand in</div>
                    ) : !q.objectives ? (
                      <div className={s.note}>objectives unknown: all its quest items show</div>
                    ) : (
                      <Objectives open={openObjectives(q)} itemName={itemName} />
                    )}
                  </QuestRow>
                );
              })}
            </ul>
          </Section>
        );
      })}
      <ImportedSection prefs={prefs} onPrefs={onPrefs} live={live} kindSwitch={kindSwitch("imported")} kindOn={!counting.ignoredKinds.has("imported")} toggleQuest={toggleQuest} itemName={itemName} />
    </PanelBody>
  );
}

interface RowProps {
  id: string;
  label: string;
  meta: (string | undefined)[];
  counts: boolean;
  /** Its kind counts (else the quest's own switch doesn't matter). */
  kindOn: boolean;
  ready?: boolean;
  onToggle: () => void;
  onRemove?: () => void;
  children: ReactNode;
}

function QuestRow({ id, label, meta, counts: on, kindOn, ready, onToggle, onRemove, children }: RowProps) {
  return (
    <li className={s.quest} data-counts={ready || (on && kindOn)}>
      <div className={s.head}>
        <label className={s.label} title={id}>
          {ready ? (
            <span className={s.ready} title="Ready to hand in: needs nothing more">
              ✓
            </span>
          ) : (
            <Switch
              size="sm"
              checked={on}
              onChange={onToggle}
              title={!kindOn ? "Its whole kind is ignored (the switch in the heading)" : on ? "Counts: its items are needed (click: ignore it)" : "Ignored: its items aren't needed (click: count it)"}
            />
          )}
          <span className={s.name}>{label}</span>
          {meta.filter(Boolean).map((m) => (
            <span key={m} className={s.meta}>
              {m}
            </span>
          ))}
        </label>
        {onRemove && (
          <Button variant="icon" title="Remove the imported quest" onClick={onRemove}>
            <X size={14} />
          </Button>
        )}
      </div>
      {children}
    </li>
  );
}

function Objectives({ open, itemName, names }: { open: ReturnType<typeof openObjectives>; itemName: (tpl: string, names?: Record<string, string>) => string; names?: Record<string, string> }) {
  if (!open.length) return <div className={s.note}>no items left to find</div>;
  return (
    <ul className={s.objectives}>
      {open.map(({ objective: o, items, progress }) => (
        <li key={o.id} title={o.text}>
          {VERBS[o.type]} {o.count > 1 ? `${progress ? `${progress}/` : ""}${o.count}× ` : ""}
          {items.length <= LISTED_ITEMS ? items.map((t) => itemName(t, names)).join(" / ") : `any of ${items.length} items`}
          {o.fir && <span className={s.fir}> FIR</span>}
        </li>
      ))}
    </ul>
  );
}

/** An imported quest's objectives as a not yet started quest's. */
const importedOpen = (q: ImportedQuest) => openObjectives({ id: q.id, status: QUEST_STARTED, done: [], objectives: q.objectives });

const itemObjectives = (os: readonly QuestObjective[]) => os.filter((o) => o.items.length).length;

interface ImportedProps {
  prefs: QuestPrefs;
  onPrefs: SetStored<QuestPrefs>;
  /** Ids of the quests in the game's list (started or ready): an imported one there counts as that. */
  live: ReadonlySet<string>;
  kindSwitch: ReactNode;
  kindOn: boolean;
  toggleQuest: (id: string) => void;
  itemName: (tpl: string, names?: Record<string, string>) => string;
}

function ImportedSection({ prefs, onPrefs, live, kindSwitch, kindOn, toggleQuest, itemName }: ImportedProps) {
  const [importing, setImporting] = useState(false);
  const list = [...prefs.imported].sort((a, b) => a.name.localeCompare(b.name));
  const remove = (id: string) => onPrefs((p) => ({ ...p, imported: p.imported.filter((q) => q.id !== id), ignored: p.ignored.filter((x) => x !== id) }));
  const add = (q: ImportedQuest) => onPrefs((p) => (p.imported.some((x) => x.id === q.id) ? p : { ...p, imported: [...p.imported, q] }));
  return (
    <Section title={`${KIND_TITLES.imported} · ${list.length}`} aside={kindSwitch}>
      {!list.length && <p className="muted">Quests not started yet whose items you want to collect already: import them from tarkov.dev.</p>}
      <ul className={s.quests} data-on={kindOn}>
        {list.map((q) => {
          const started = live.has(q.id);
          return (
            <QuestRow
              key={q.id}
              id={q.id}
              label={q.name}
              meta={[traderName(q.trader), started ? "started" : undefined]}
              counts={!prefs.ignored.includes(q.id)}
              kindOn={kindOn}
              onToggle={() => toggleQuest(q.id)}
              onRemove={() => remove(q.id)}
            >
              {started ? <div className={s.note}>started: counts with its kind above</div> : <Objectives open={importedOpen(q)} itemName={itemName} names={q.itemNames} />}
            </QuestRow>
          );
        })}
      </ul>
      {importing ? (
        <ImportSearch imported={prefs.imported} live={live} onAdd={add} onClose={() => setImporting(false)} />
      ) : (
        <Actions>
          <Button onClick={() => setImporting(true)}>Import from tarkov.dev…</Button>
        </Actions>
      )}
    </Section>
  );
}

function ImportSearch({ imported, live, onAdd, onClose }: { imported: readonly ImportedQuest[]; live: ReadonlySet<string>; onAdd: (q: ImportedQuest) => void; onClose: () => void }) {
  const [feed, setFeed] = useState<TaskFeed | null>(null);
  const [text, setText] = useState("");
  useEffect(() => {
    let alive = true;
    void loadTaskFeed().then((f) => alive && setFeed(f));
    return () => void (alive = false);
  }, []);
  const term = text.trim().toLowerCase();
  const results = useMemo(() => (feed && term.length >= 2 ? feed.quests.filter((q) => q.name.toLowerCase().includes(term)).slice(0, MAX_RESULTS) : []), [feed, term]);
  return (
    <div className={s.import}>
      <div className={s.searchRow}>
        <TextInput autoFocus placeholder="Quest name" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Escape" && onClose()} />
        <Button variant="icon" title="Close" onClick={onClose}>
          <X size={14} />
        </Button>
      </div>
      {!feed && <div className={s.note}>loading tarkov.dev's quests…</div>}
      {feed?.error && <Note tone="alert">tarkov.dev: {feed.error}{feed.quests.length ? " (using the cached list)" : ""}</Note>}
      {feed && term.length >= 2 && !results.length && <div className={s.note}>no quest found (tarkov.dev has no story, event or SPT quests)</div>}
      <ul className={s.results}>
        {results.map((q) => {
          const n = itemObjectives(q.objectives);
          const why = imported.some((x) => x.id === q.id) ? "imported" : live.has(q.id) ? "started" : !n ? "no items" : null;
          return (
            <li key={q.id}>
              <button className={s.result} disabled={!!why} onClick={() => onAdd(q)} title={why ? undefined : `Import: its ${n} item objective${n === 1 ? "" : "s"} count`}>
                <span className={s.name}>{q.name}</span>
                <span className={s.meta}>{[traderName(q.trader), why ?? `${n} item objective${n === 1 ? "" : "s"}`].filter(Boolean).join(" · ")}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
