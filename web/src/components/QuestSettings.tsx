// Settings → Quests: whether what's owned covers what quests need, and quests imported from
// tarkov.dev (not started yet, whose items count already). Which quests are tracked is the Watch
// view's (the quest picker); quests don't count or not one by one any more.

import { X } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import type { ItemCatalog } from "../model/items";
import type { QuestObjective, QuestState } from "../model/protocol";
import { type QuestNeeds, QUEST_READY, QUEST_STARTED, openObjectives, traderName } from "../model/quests";
import { type ImportedQuest, type TaskFeed, loadTaskFeed } from "../model/taskFeed";
import type { QuestPrefs } from "../persist/prefs";
import type { SetStored } from "../persist";
import { Actions, Button, Note, Section, Switch, TextInput } from "../ui";
import s from "./QuestSettings.module.css";
import type { OwnedState } from "./useOwned";

interface Props {
  /** The raid's quests (before any filtering); null when they weren't read. */
  quests: readonly QuestState[] | null;
  catalog: ItemCatalog;
  prefs: QuestPrefs;
  onPrefs: SetStored<QuestPrefs>;
  /** What the quest item filter knows right now, e.g. "3 quests started, 5 items needed". */
  questInfo: string;
  /** What the counting quests need, with what's owned set aside for each objective. */
  needs: QuestNeeds | null;
  owned: OwnedState;
}

const VERBS = { find: "Find", handover: "Hand over", plant: "Plant" } as const;
/** Items listed by name for an objective; more: "any of N items". */
const LISTED_ITEMS = 3;
/** Search results shown when importing. */
const MAX_RESULTS = 15;

export function QuestSettings({ quests, catalog, prefs, onPrefs, questInfo, needs, owned }: Props) {
  const live = new Set((quests ?? []).filter((q) => q.status === QUEST_STARTED || q.status === QUEST_READY).map((q) => q.id));
  const itemName = (tpl: string, names?: Record<string, string>) => names?.[tpl] ?? catalog.lookup(tpl)?.name ?? tpl;
  return (
    <>
      <Section
        title="Owned items count"
        aside={
          <Switch
            size="sm"
            checked={!prefs.ignoreOwned}
            onChange={() => onPrefs((p) => ({ ...p, ignoreOwned: !p.ignoreOwned }))}
            title={prefs.ignoreOwned ? "Owned items are ignored: everything still to hand in is needed (click: count them)" : "Owned items count: what you have isn't needed (click: ignore them)"}
          />
        }
      >
        <p className="muted">Items in your stash and on your character count toward what a quest still needs. {ownedInfo(owned)}</p>
        <p className="muted">{quests ? questInfo : "No quests read (not in a raid, or an older recording)."}</p>
      </Section>
      <ImportedSection prefs={prefs} onPrefs={onPrefs} live={live} itemName={itemName} needs={needs} />
    </>
  );
}

interface RowProps {
  id: string;
  label: string;
  meta: (string | undefined)[];
  counts: boolean;
  ready?: boolean;
  onRemove?: () => void;
  children: ReactNode;
}

function QuestRow({ id, label, meta, counts: on, ready, onRemove, children }: RowProps) {
  return (
    <li className={s.quest} data-counts={ready || on}>
      <div className={s.head}>
        <label className={s.label} title={id}>
          {ready && (
            <span className={s.ready} title="Ready to hand in: needs nothing more">
              ✓
            </span>
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

type Open = ReturnType<typeof openObjectives>;

/** Every open objective is covered by what's owned (and it counts, so there are needs). */
const allOwned = (questId: string, open: Open, needs: QuestNeeds | null) =>
  open.length > 0 && open.every(({ objective: o }) => needs?.objectives.get(`${questId}/${o.id}`)?.covered);

function ownedInfo({ owned, stash, keptAt }: OwnedState): string {
  if (!owned && !stash) return "Stash not read yet: it's read in a raid (then kept). Gear on the character counts in a raid.";
  if (!stash) return "Stash not read yet; the gear on the character counts.";
  const items = stash.stash.length;
  const when = keptAt === null ? "as of this raid's start" : `kept from ${new Date(keptAt).toLocaleString()}`;
  return `Stash ${when}: ${items} different items, plus the gear on the character. Objectives they cover need nothing more.`;
}

function Objectives({
  questId,
  open,
  needs,
  itemName,
  names,
}: {
  questId: string;
  open: Open;
  needs: QuestNeeds | null;
  itemName: (tpl: string, names?: Record<string, string>) => string;
  names?: Record<string, string>;
}) {
  if (!open.length) return <div className={s.note}>no items left to find</div>;
  return (
    <ul className={s.objectives}>
      {open.map(({ objective: o, items, progress }) => {
        const need = needs?.objectives.get(`${questId}/${o.id}`);
        return (
          <li key={o.id} title={o.text} data-covered={!!need?.covered}>
            {VERBS[o.type]} {o.count > 1 ? `${progress ? `${progress}/` : ""}${o.count}× ` : ""}
            {items.length <= LISTED_ITEMS ? items.map((t) => itemName(t, names)).join(" / ") : `any of ${items.length} items`}
            {o.fir && <span className={s.fir}> FIR</span>}
            {need?.covered ? (
              <span className={s.have} title="Owned (stash or on the character): needs nothing more">
                {" "}
                ✓ have
              </span>
            ) : need?.have ? (
              <span className={s.have} title="Owned (stash or on the character)">
                {" "}
                have {need.have}
              </span>
            ) : null}
          </li>
        );
      })}
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
  itemName: (tpl: string, names?: Record<string, string>) => string;
  needs: QuestNeeds | null;
}

function ImportedSection({ prefs, onPrefs, live, itemName, needs }: ImportedProps) {
  const [importing, setImporting] = useState(false);
  const list = [...prefs.imported].sort((a, b) => a.name.localeCompare(b.name));
  const remove = (id: string) => onPrefs((p) => ({ ...p, imported: p.imported.filter((q) => q.id !== id), ignored: p.ignored.filter((x) => x !== id) }));
  const add = (q: ImportedQuest) => onPrefs((p) => (p.imported.some((x) => x.id === q.id) ? p : { ...p, imported: [...p.imported, q] }));
  return (
    <Section title={`Imported from tarkov.dev · ${list.length}`}>
      {!list.length && <p className="muted">Quests not started yet whose items you want to collect already: import them from tarkov.dev.</p>}
      <ul className={s.quests}>
        {list.map((q) => {
          const started = live.has(q.id);
          const open = importedOpen(q);
          return (
            <QuestRow
              key={q.id}
              id={q.id}
              label={q.name}
              meta={[traderName(q.trader), started ? "started" : undefined, !started && allOwned(q.id, open, needs) ? "all owned" : undefined]}
              counts
              onRemove={() => remove(q.id)}
            >
              {started ? <div className={s.note}>started: counts with its kind above</div> : <Objectives questId={q.id} open={open} needs={needs} itemName={itemName} names={q.itemNames} />}
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
