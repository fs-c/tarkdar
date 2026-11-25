// Details card for the selected thing (player, loot, exfil, explosive), below the top right corner.
// What it is first: a title (colour dot, name, state), one line of what matters at a glance (tier,
// state, distance, value), then why it matters (what they carry that you're after, what a quest needs
// it for, which watch entries mark it), its kit, history and actions. The raw fields (side, role,
// template, position, the rules behind its look) are folded away under Debug.

import { Binoculars, LocateFixed, Route, X } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { vehicleOf } from "../model/vehicles";
import type { RadarState } from "../stream/connection";
import { describeEvent, eventConcerns } from "../stream/events";
import { type ItemCatalog, type ItemInfo, containerName, equipmentValue, formatHeightDiff, formatPrice, slotValue } from "../model/items";
import { exfilStatus } from "../model/exfils";
import type { Selection } from "../draw/pick";
import { COLORS } from "../draw/style";
import type { ItemNode, WorldPos } from "../model/protocol";
import { type QuestNeed, carriedNeededItems, formatQuestNeed, questNeedExtra } from "../model/quests";
import { type AnyRow, type PlayerRow, carried, withDistances } from "../list/rows";
import { WILD_SPAWN_TYPES, bossGroups, playerType } from "../model/roles";
import { quote } from "../highlight/query";
import type { Timeline, TimelineEvent } from "../stream/timeline";
import { formatDuration } from "../stream/playback";
import type { Contribution, Style } from "../rules/rules";
import { LEVEL_TEXT } from "../watch/levels";
import type { WatchEntry } from "../watch/prefs";
import { type CarriedMark, QUEST_COLOR, watchRuleId } from "../watch/rules";
import { TIERS, tierOf } from "../watch/tiers";
import { Button, Price, cx } from "../ui";
import { Distance, type Viewpoint } from "./PlayersView";
import f from "./Floating.module.css";
import v from "./views.module.css";
import s from "./DetailsPanel.module.css";

/** Why it looks the way it does (rules.ts explainStyle). */
export interface Look {
  parts: Contribution[];
  style: Style;
  hiddenByGroup: boolean;
}

/** The raid's history, for the History section. */
export interface HistoryProps {
  timeline: Timeline;
  /** The shown moment. */
  at: number;
  /** Raid start. */
  start: number;
  onPick: (e: TimelineEvent) => void;
}

interface Props {
  selection: Selection;
  state: RadarState;
  catalog: ItemCatalog;
  /** Template id → the started quests' objectives that still need it (quests.ts). */
  questNeeds: ReadonlyMap<string, readonly QuestNeed[]>;
  /** The selection's row (list/rows.ts): its type, value, ...; undefined if it's gone. */
  row: AnyRow | undefined;
  /** Where you are and look: the distance and its arrow. */
  local: Viewpoint;
  look: Look | null;
  history: HistoryProps | null;
  entries: readonly WatchEntry[];
  /** What the selected player carries that a watch entry is after (watch/rules.ts carriedMarks). */
  carried: readonly CarriedMark[] | undefined;
  /** Quest ids tracked (a watch entry each). */
  tracked: ReadonlySet<string>;
  /** Debug starts unfolded (Settings → Debug). */
  debugOpen: boolean;
  /** The selected player's trail, when there's a timeline to draw it from. */
  trail: { on: boolean; toggle: () => void } | null;
  onCentre: () => void;
  onWatch: (label: string, query: string) => void;
  onClose: () => void;
}

export function DetailsPanel(props: Props) {
  const row = props.row && withDistances([props.row], props.local?.pos ?? null)[0];
  return (
    <div className={cx(f.belowTopRight, s.details)}>
      <Details {...props} row={row} />
    </div>
  );
}

function Details(p: Props) {
  const { selection: sel, state, catalog, row } = p;
  if (sel.kind === "player") {
    const pl = state.players.find((x) => x.id === sel.id);
    if (!pl) return <Gone p={p} what="Player" text="no longer in the raid" />;
    const r = row?.subject === "player" ? (row as PlayerRow) : undefined;
    const eq = state.equipment.get(pl.id)?.slots;
    const t = playerType(pl, bossGroups(state.players));
    const tier = tierOf(t.type);
    const st = r?.state ?? (pl.dead ? "dead" : "alive");
    const gone = st !== "alive";
    const color = pl.local ? COLORS.local : gone ? COLORS.dead : (p.look?.style.color ?? (tier ? TIERS[tier].color : undefined));
    const stateText = st === "left" ? "left the raid" : st;
    return (
      <>
        <Title p={p} color={color} chip={gone ? stateText : undefined}>
          <span className={cx(t.type === "boss" && !gone && s.bold)}>{pl.local ? "You" : t.label}</span> <span className={s.id}>{pl.id}</span>
        </Title>
        <Sub
          parts={[
            pl.local ? "you" : tier ? TIERS[tier].name : t.type,
            stateText,
            !gone && vehicleOf(state.vehicles, pl.id) && "riding the BTR",
            st !== "left" && st !== "extracted" && far(r, p.local),
            gear(r?.value),
          ]}
        />
        {!pl.local && <Wanted nodes={eq} marks={p.carried} catalog={catalog} questNeeds={p.questNeeds} />}
        <Kit nodes={eq} catalog={catalog} />
        <AllItems summary="All equipment" nodes={eq} empty="Equipment not read (yet)" catalog={catalog} />
        <WatchedBy look={p.look} entries={p.entries} />
        <History {...p} />
        <Acts>
          <CentreButton p={p} />
          {p.trail && (
            <Button aria-pressed={p.trail.on} title="Where they've been, the whole raid" onClick={p.trail.toggle}>
              <Route size={13} /> Trail
            </Button>
          )}
        </Acts>
        <Debug p={p}>
          {/* The raw inputs, so a misclassified player can be traced to the rule that should catch it. */}
          <KV k="type" v={t.label === t.type ? t.type : `${t.label} (${t.type})`} />
          <KV k="from" v={t.reason} />
          <KV k="side" v={pl.side + (pl.ai ? " (AI)" : "")} />
          {pl.role !== undefined && <KV k="role" v={`${WILD_SPAWN_TYPES[pl.role]?.[0] ?? "unmapped"} = ${pl.role}`} />}
          {pl.voice && <KV k="voice" v={pl.voice} />}
          {pl.nickname && <KV k="nickname" v={pl.nickname} />}
          {pl.groupId && <KV k="group" v={pl.groupId} />}
          {pl.kind && <KV k="kind" v={pl.kind} />}
          <KV k="position" v={formatPos(pl.pos)} />
        </Debug>
      </>
    );
  }

  if (sel.kind === "loot") {
    const l = state.loot.find((x) => x.id === sel.id);
    if (!l) return <Gone p={p} what="Loot" text="picked up or gone" />;
    const objectRows = (
      <>
        {l.tpl && <KV k="template" v={l.tpl} />}
        <KV k="object" v={l.obj} />
        <KV k="position" v={formatPos(l.pos)} />
      </>
    );

    if (l.kind === "corpse") {
      return (
        <>
          <Title p={p} color={p.look?.style.color ?? COLORS.dead}>Corpse</Title>
          <Sub parts={[far(row, p.local), gear(row?.value)]} />
          <Wanted nodes={l.contents} catalog={catalog} questNeeds={p.questNeeds} />
          <Kit nodes={l.contents} catalog={catalog} />
          <AllItems summary="On the body" nodes={l.contents} empty="Nothing on the body (or it can't be read)" catalog={catalog} open />
          <WatchedBy look={p.look} entries={p.entries} />
          <History {...p} />
          <Acts>
            <CentreButton p={p} />
          </Acts>
          <Debug p={p}>{objectRows}</Debug>
        </>
      );
    }

    if (l.kind === "container" || l.kind === "airdrop") {
      return (
        <>
          <Title p={p} color={p.look?.style.color}>{l.kind === "airdrop" ? "Airdrop" : (containerName(l.tpl) ?? "Container")}</Title>
          <Sub parts={[l.kind, far(row, p.local), "contents can't be read"]} />
          <WatchedBy look={p.look} entries={p.entries} />
          <Acts>
            <CentreButton p={p} />
          </Acts>
          <Debug p={p}>{objectRows}</Debug>
        </>
      );
    }

    const info = catalog.lookup(l.tpl);
    const needs = p.questNeeds.get(l.tpl);
    const perSlot = slotValue(info);
    const category = ownCategory(info, catalog);
    const itemQuery = info && `item:${quote(info.name)}`;
    const catQuery = category && `cat:${quote(category)}`;
    const watching = (q: string) => p.entries.some((e) => e.query === q && e.on);
    return (
      <>
        <Title p={p} color={p.look?.style.color}>
          <span className={cx(l.kind === "quest" && s.quest)}>{info?.name ?? (l.kind === "quest" ? "Quest item" : "Item")}</span>
        </Title>
        <Sub
          parts={
            l.kind === "quest"
              ? ["quest item", far(row, p.local)]
              : perSlot !== undefined && info?.price !== undefined
                ? [
                    <Price base={info.priceSource === "base"}>{formatPrice(perSlot)} ₽/slot</Price>,
                    (info.slots ?? 1) > 1 && `${formatPrice(info.price)} each, ${info.slots} slots`,
                    info.priceSource === "trader" && "trader price",
                    far(row, p.local),
                  ]
                : ["no price data", far(row, p.local)]
          }
        />
        {!!needs?.length && (
          <Section title="Needed for">
            <ul className={s.list}>
              {needs.map((n, i) => (
                <li key={i}>
                  {n.quest} {questNeedExtra(n) && <span className={s.muted}>({questNeedExtra(n)})</span>}
                  {n.questId && p.tracked.has(n.questId) && <span className={s.chip}>tracked</span>}
                </li>
              ))}
            </ul>
          </Section>
        )}
        <WatchedBy look={p.look} entries={p.entries} />
        <History {...p} />
        <Acts>
          <CentreButton p={p} />
          {info && itemQuery && (watching(itemQuery) ? (
            <span className={s.chip}>watching {info.shortName}</span>
          ) : (
            <Button className={v.primary} title={`Watch every ${info.name}`} onClick={() => p.onWatch(info.shortName, itemQuery)}>
              <Binoculars size={13} /> Watch {info.shortName}
            </Button>
          ))}
          {category && catQuery && !watching(catQuery) && (
            <Button title={`Watch everything in ${category}`} onClick={() => p.onWatch(category, catQuery)}>
              Watch {category}
            </Button>
          )}
        </Acts>
        <Debug p={p}>
          <KV k="kind" v={l.kind} />
          {info?.price !== undefined && <KV k="price" v={`${formatPrice(info.price)} ₽ (${info.priceSource ?? "?"})`} />}
          {objectRows}
        </Debug>
      </>
    );
  }

  if (sel.kind === "grenade") {
    const g = state.explosives.grenades.find((x) => x.id === sel.id);
    if (!g) return <Gone p={p} what="Grenade" text="exploded" />;
    return (
      <>
        <Title p={p} color={p.look?.style.color}>Grenade</Title>
        <Sub parts={["thrown", far(row, p.local)]} />
        <Acts>
          <CentreButton p={p} />
        </Acts>
        <Debug p={p}>
          <KV k="position" v={formatPos(g.pos)} />
        </Debug>
      </>
    );
  }

  if (sel.kind === "tripwire") {
    const w = state.explosives.tripwires.find((x) => x.id === sel.id);
    if (!w) return <Gone p={p} what="Tripwire" text="gone" />;
    const length = Math.hypot(w.to[0] - w.from[0], w.to[2] - w.from[2]);
    return (
      <>
        <Title p={p} color={p.look?.style.color}>Tripwire</Title>
        <Sub parts={[`${Math.round(length)} m long`, far(row, p.local)]} />
        <Acts>
          <CentreButton p={p} />
        </Acts>
        <Debug p={p}>
          <KV k="from" v={formatPos(w.from)} />
          <KV k="to" v={formatPos(w.to)} />
        </Debug>
      </>
    );
  }

  if (sel.kind === "vehicle") return <Gone p={p} what="Vehicle" text="" />;

  const e = state.exfils.find((x) => x.id === sel.id);
  if (!e) return <Gone p={p} what="Exfil" text="gone" />;
  const status = exfilStatus(e.status);
  return (
    <>
      <Title p={p}>{e.name}</Title>
      <Sub
        parts={[
          <span className={v.status} data-tone={status.tone}>{status.label}</span>,
          e.kind === "secret" && <span className={v.status} data-tone="secret">secret</span>,
          far(row, p.local),
        ]}
      />
      <History {...p} />
      <Acts>
        <CentreButton p={p} />
      </Acts>
      <Debug p={p}>
        <KV k="kind" v={e.kind} />
        <KV k="status" v={`${status.label} = ${e.status}`} />
        <KV k="position" v={formatPos(e.pos)} />
      </Debug>
    </>
  );
}

// ---- pieces ----

function Title({ p, color, chip, children }: { p: Props; color?: string; chip?: string; children: ReactNode }) {
  return (
    <h3 className={s.title}>
      {color && <span className={s.dot} style={{ background: color }} />}
      <span className={s.name}>{children}</span>
      {chip && <span className={s.chip}>{chip}</span>}
      <Button variant="icon" className={s.close} title="Close (Esc)" onClick={p.onClose}>
        <X size={14} />
      </Button>
    </h3>
  );
}

/** The line under the title: its parts (those there are) joined by " · ". */
function Sub({ parts }: { parts: ReactNode[] }) {
  const shown = parts.filter((x) => x !== null && x !== undefined && x !== false && x !== "");
  if (!shown.length) return null;
  return (
    <div className={s.sub}>
      {shown.map((x, i) => (
        <Fragment key={i}>
          {i ? " · " : ""}
          {x}
        </Fragment>
      ))}
    </div>
  );
}

/** "↗ 34 m ▲3"; null without a distance. */
function far(row: { dist?: number; dh?: number; pos: WorldPos | null } | undefined, from: Viewpoint): ReactNode {
  if (row?.dist === undefined) return null;
  const dh = formatHeightDiff(row.dh);
  return (
    <>
      <Distance row={row} from={from} plain />
      {dh && ` ${dh}`}
    </>
  );
}

/** "gear 277k ₽": what a player or corpse carries is worth; null when unknown. */
function gear(value: number | undefined): ReactNode {
  if (value === undefined) return null;
  return (
    <>
      {"gear "}
      <Price>{formatPrice(value)} ₽</Price>
    </>
  );
}

function Gone({ p, what, text }: { p: Props; what: string; text: string }) {
  return (
    <>
      <Title p={p}>{what}</Title>
      <Sub parts={[text]} />
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <h4 className={s.heading}>{title}</h4>
      {children}
    </>
  );
}

function Acts({ children }: { children: ReactNode }) {
  return <div className={s.acts}>{children}</div>;
}

function CentreButton({ p }: { p: Props }) {
  return (
    <Button title="Bring it into view" onClick={p.onCentre}>
      <LocateFixed size={13} /> Centre
    </Button>
  );
}

function KV({ k, v: value }: { k: string; v: string }) {
  return (
    <>
      <span>{k}</span>
      <span>{value}</span>
    </>
  );
}

/** The raw fields and the rules behind the look, folded unless Settings → Debug says otherwise. */
function Debug({ p, children }: { p: Props; children: ReactNode }) {
  return (
    // Keyed so the setting applies when it changes; a click folds or unfolds this one only.
    <details key={String(p.debugOpen)} className={s.debug} open={p.debugOpen}>
      <summary>Debug</summary>
      <div className={s.kv}>{children}</div>
      {p.look && <LookRows look={p.look} />}
    </details>
  );
}

/** Watch entries that mark it, from its look's rules (the entry that wins first). */
function WatchedBy({ look, entries }: { look: Look | null; entries: readonly WatchEntry[] }) {
  if (!look) return null;
  const ids = new Set(look.parts.map((c) => c.rule.id));
  const by = entries.filter((e) => e.on && ids.has(watchRuleId(e.id))).reverse();
  if (!by.length) return null;
  return (
    <Section title="Watched by">
      <ul className={s.list}>
        {by.map((e) => (
          <li key={e.id}>
            <span className={s.dot} style={{ background: e.color }} />
            {e.label} <span className={s.muted}>({LEVEL_TEXT[e.level]})</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** What a player or corpse carries that you're after: what watch entries mark on a player (corpses:
 *  Watched by) and what started quests need. */
function Wanted(props: { nodes: ItemNode[] | undefined; catalog: ItemCatalog; questNeeds: Props["questNeeds"]; marks?: readonly CarriedMark[] }) {
  const { nodes, catalog, questNeeds } = props;
  if (!nodes?.length) return null;
  const c = carried(nodes, catalog);
  const needed = questNeeds.size ? carriedNeededItems(c.tpls, questNeeds, c.fir) : [];
  const marks = props.marks ?? [];
  if (!needed.length && !marks.length) return null;
  return (
    <Section title="Carrying what you're after">
      <ul className={s.list}>
        {marks.map((m) => (
          <li key={m.entryId}>
            <span className={s.pip} style={{ background: m.color }} />
            {m.label} <span className={s.muted}>watched</span>
          </li>
        ))}
        {needed.map(({ tpl, count, needs }) => {
          const info = catalog.lookup(tpl);
          return (
            <li key={tpl}>
              <span className={s.pip} style={{ background: QUEST_COLOR }} />
              <span title={info ? `${info.name}\n${tpl}` : tpl}>{info?.name ?? tpl}</span>
              {count > 1 && <span className={s.muted}> ×{count}</span>}
              <span className={s.muted}>{` for ${needs.map(formatQuestNeed).join("; ")}`}</span>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

/** The slots worth a glance, in this order (the first one filled of each). */
const KIT: { label: string; slots: string[] }[] = [
  { label: "weapon", slots: ["FirstPrimaryWeapon", "SecondPrimaryWeapon", "Holster"] },
  { label: "armor", slots: ["ArmorVest"] },
  { label: "rig", slots: ["TacticalVest"] },
  { label: "helmet", slots: ["Headwear"] },
  { label: "backpack", slots: ["Backpack"] },
];

function Kit({ nodes, catalog }: { nodes: ItemNode[] | undefined; catalog: ItemCatalog }) {
  if (!nodes?.length) return null;
  const rows = KIT.flatMap(({ label, slots }) => {
    const n = slots.map((sl) => nodes.find((x) => x.slot === sl)).find(Boolean);
    if (!n) return [];
    const info = catalog.lookup(n.tpl);
    const cls = info?.armorClass ?? armorClassOf(n, catalog);
    return [{ label, name: info?.shortName ?? n.tpl, title: info?.name, cls }];
  });
  if (!rows.length) return null;
  return (
    <Section title="Kit">
      <div className={s.kv}>
        {rows.map((r) => (
          <KitRow key={r.label} {...r} />
        ))}
      </div>
    </Section>
  );
}

function KitRow({ label, name, title, cls }: { label: string; name: string; title?: string; cls?: number }) {
  return (
    <>
      <span>{label}</span>
      <span title={title}>
        {name}
        {cls ? <span className={s.muted}> · class {cls}</span> : null}
      </span>
    </>
  );
}

/** Armour from its plates (vests and rigs carry their class in the plates): the highest. */
function armorClassOf(n: ItemNode, catalog: ItemCatalog): number | undefined {
  let best: number | undefined;
  for (const c of n.items ?? []) {
    const k = catalog.lookup(c.tpl)?.armorClass;
    if (k && (best === undefined || k > best)) best = k;
  }
  return best;
}

/** The whole item tree, folded (or open), its count and value in the summary. */
function AllItems(props: { summary: string; nodes: ItemNode[] | undefined; empty: string; catalog: ItemCatalog; open?: boolean }) {
  const { summary, nodes, empty, catalog } = props;
  if (!nodes?.length) return <div className={cx(s.muted, s.gap)}>{empty}</div>;
  const v = equipmentValue(nodes, catalog);
  return (
    <details className={s.fold} open={props.open}>
      <summary>
        {summary} ({countItems(nodes)}){v > 0 && <> · <Price>{formatPrice(v)} ₽</Price></>}
      </summary>
      <ItemTree nodes={nodes} catalog={catalog} />
    </details>
  );
}

const countItems = (ns: ItemNode[]): number => ns.reduce((a, n) => a + 1 + countItems(n.items ?? []), 0);

function ItemTree({ nodes, catalog }: { nodes: ItemNode[]; catalog: ItemCatalog }) {
  return (
    <ul className={s.items}>
      {nodes.map((n, i) => {
        const info = catalog.lookup(n.tpl);
        return (
          <li key={i}>
            <span title={info ? `${info.name}\n${n.tpl}${n.slot ? `\nslot: ${n.slot}` : ""}` : n.tpl}>{info?.shortName ?? n.tpl}</span>
            {!!n.count && n.count > 1 && <span className={s.muted}> ×{n.count}</span>}
            {n.fir && <span className={s.faint} title="found in raid (Item.SpawnedInSession)"> FIR</span>}
            {!!info?.price && <Price base={info.priceSource === "base"}>{` ${formatPrice(info.price * (n.count ?? 1))}`}</Price>}
            {!!n.items?.length && <ItemTree nodes={n.items} catalog={catalog} />}
          </li>
        );
      })}
    </ul>
  );
}

function History({ selection, catalog, history }: Props) {
  if (!history) return null;
  const { timeline, at, start, onPick } = history;
  // Later events too (dimmed): in a replay, what's still to come is worth knowing.
  const events = timeline.events.filter((e) => eventConcerns(e, selection));
  const track = selection.kind === "player" ? timeline.tracks.get(selection.id) : undefined;
  if (!events.length && !track) return null;
  return (
    <Section title="History">
      {track && <div className={s.muted}>{`travelled ${Math.round(track.distanceUntil(at))} m`}</div>}
      <ul className={s.history}>
        {events.map((e, i) => {
          const d = describeEvent(e, timeline, catalog);
          return (
            <li key={i}>
              <button type="button" className={s.event} data-tone={d.tone} data-future={e.t > at} title="Show this moment" onClick={() => onPick(e)}>
                <span className={s.time}>{formatDuration(e.t - start)}</span> {d.text}
              </button>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

const PROP_TEXT: Record<keyof Style, (s: Style) => string> = {
  color: (st) => `colour ${st.color ?? "own"}`,
  ring: (st) => `ring ${st.ring}`,
  emphasis: (st) => st.emphasis,
  show: (st) => (st.show === null ? "hidden" : st.show === 0 ? "always shown" : `shown from detail ${st.show}`),
  label: (st) => `label: ${st.label}`,
  labelFrom: (st) => `labels from detail ${st.labelFrom}`,
};

/** The rules that make its look, the one that wins first; what a later rule overrides struck through. */
function LookRows({ look }: { look: Look }) {
  const { parts, hiddenByGroup } = look;
  return (
    <div className={s.look}>
      <span className={s.lookKey}>look</span>
      {hiddenByGroup && <div>hidden: its category is off</div>}
      {!parts.length && <div>no rule matches: its kind's base look</div>}
      <ul>
        {[...parts].reverse().map((c) => (
          <li key={c.rule.id} title={c.rule.query}>
            <span className={s.lookRule}>{c.rule.label || c.rule.id}: </span>
            {c.set.map((k, i) => {
              const one = { ...look.style, ...c.rule.style } as Style;
              return (
                <span key={k} className={c.overridden.includes(k) ? s.overridden : undefined}>
                  {i ? ", " : ""}
                  {PROP_TEXT[k](one)}
                </span>
              );
            })}
            {!c.set.length && <span>(sets nothing)</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---- helpers ----

/** The item's own handbook category (the deepest of those it's in): what "Watch <category>" watches. */
function ownCategory(info: ItemInfo | undefined, catalog: ItemCatalog): string | undefined {
  if (!info?.categories?.length) return undefined;
  const ids = new Set(info.categories);
  let best: { name: string; depth: number } | undefined;
  for (const c of catalog.categories()) {
    if (!ids.has(c.id)) continue;
    const depth = c.path ? c.path.split(" › ").length : 0;
    if (!best || depth > best.depth) best = { name: c.name, depth };
  }
  return best?.name;
}

function formatPos(p: WorldPos | null | undefined): string {
  return p ? p.map((x) => x.toFixed(1)).join(", ") : "unknown";
}
