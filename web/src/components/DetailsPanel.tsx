// Details panel for a selected player, loot entry or exfil.

import { vehicleOf } from "../model/vehicles";
import type { RadarState } from "../stream/connection";
import { describeEvent, eventConcerns } from "../stream/events";
import { type ItemCatalog, containerName, equipmentValue, formatPrice } from "../model/items";
import { exfilStatus } from "../model/exfils";
import type { Selection } from "../draw/pick";
import type { ItemNode, WorldPos } from "../model/protocol";
import { type QuestNeed, carriedNeededItems, formatQuestNeed } from "../model/quests";
import { carried } from "../list/rows";
import { WILD_SPAWN_TYPES, bossGroups, playerType } from "../model/roles";
import type { Timeline, TimelineEvent } from "../stream/timeline";
import { formatDuration } from "../stream/playback";
import type { Contribution, Style } from "../rules/rules";
import { Price, cx } from "../ui";
import f from "./Floating.module.css";
import s from "./DetailsPanel.module.css";

interface Props {
  selection: Selection;
  state: RadarState;
  catalog: ItemCatalog;
  /** Template id → the started quests' objectives that still need it (quests.ts). */
  questNeeds: ReadonlyMap<string, readonly QuestNeed[]>;
}

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

interface DetailsPanelProps extends Props {
  history: HistoryProps | null;
  look: Look | null;
}

export function DetailsPanel(props: DetailsPanelProps) {
  return (
    <div className={cx(f.belowTopRight, s.details)}>
      <Details {...props} />
      {props.look && <LookSection look={props.look} />}
      {props.history && <History selection={props.selection} catalog={props.catalog} {...props.history} />}
    </div>
  );
}

function History({ selection, catalog, timeline, at, start, onPick }: HistoryProps & { selection: Selection; catalog: ItemCatalog }) {
  // Later events too (dimmed): in a replay, what's still to come is worth knowing.
  const events = timeline.events.filter((e) => eventConcerns(e, selection));
  const track = selection.kind === "player" ? timeline.tracks.get(selection.id) : undefined;
  if (!events.length && !track) return null;
  return (
    <>
      <h4 className={s.heading}>history</h4>
      {track && <Line label="distance" value={`${Math.round(track.distanceUntil(at))} m`} />}
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
    </>
  );
}

function Details({ selection: sel, state, catalog, questNeeds }: Props) {
  if (sel.kind === "player") {
    const p = state.players.find((x) => x.id === sel.id);
    if (!p) return <div>player gone</div>;
    const eq = state.equipment.get(p.id);
    const t = playerType(p, bossGroups(state.players));
    return (
      <>
        <h3 className={s.title}>{p.local ? `You (#${p.id})` : `Player #${p.id}`}</h3>
        <Line label="type" value={t.label === t.type ? t.type : `${t.label} (${t.type})`} />
        <Line label="from" value={t.reason} />
        {/* The raw inputs, so a misclassified player can be traced to the rule that should catch it. */}
        <Line label="side" value={p.side + (p.ai ? " (AI)" : "")} />
        {p.role !== undefined && <Line label="role" value={`${WILD_SPAWN_TYPES[p.role]?.[0] ?? "unmapped"} = ${p.role}`} />}
        {p.voice && <Line label="voice" value={p.voice} />}
        {p.nickname && <Line label="nickname" value={p.nickname} />}
        {p.groupId && <Line label="group" value={p.groupId} />}
        {p.kind && <Line label="kind" value={p.kind} />}
        <Line label="state" value={p.dead ? "dead" : p.absent ? (p.extracted ? "extracted" : "left the raid") : "alive"} />
        {vehicleOf(state.vehicles, p.id) && <Line label="riding" value="BTR" />}
        <Line label="position" value={formatPos(p.pos)} />
        {!p.local && <NeededSection nodes={eq?.slots} catalog={catalog} questNeeds={questNeeds} />}
        <ItemSection heading="equipment" nodes={eq?.slots} empty="not read (yet)" catalog={catalog} />
      </>
    );
  }
  if (sel.kind === "loot") {
    const l = state.loot.find((x) => x.id === sel.id);
    if (!l) return <div>gone</div>;
    const info = l.kind === "container" ? undefined : catalog.lookup(l.tpl);
    const name = l.kind === "container" ? containerName(l.tpl) : info?.name;
    const needs = l.kind === "item" || l.kind === "quest" ? questNeeds.get(l.tpl) : undefined;
    return (
      <>
        <h3 className={s.title}>{name ?? l.kind}</h3>
        <Line label="kind" value={l.kind} />
        {!!info?.price && (
          <Line label="price" value={`${formatPrice(info.price)} ₽${info.priceSource === "flea" ? "" : ` (${info.priceSource === "trader" ? "trader" : "base price"})`}`} />
        )}
        {needs?.length ? <Line label="needed for" value={needs.map(formatQuestNeed).join("; ")} /> : null}
        {l.tpl && <Line label="template" value={l.tpl} />}
        <Line label="object" value={l.obj} />
        <Line label="position" value={formatPos(l.pos)} />
        {l.kind === "corpse" && <NeededSection nodes={l.contents} catalog={catalog} questNeeds={questNeeds} />}
        {l.kind === "corpse" && <ItemSection heading="equipment" nodes={l.contents} empty="none (or not readable)" catalog={catalog} />}
      </>
    );
  }
  if (sel.kind === "grenade") {
    const g = state.explosives.grenades.find((x) => x.id === sel.id);
    if (!g) return <div>exploded</div>;
    return (
      <>
        <h3 className={s.title}>Grenade</h3>
        <Line label="position" value={formatPos(g.pos)} />
      </>
    );
  }
  if (sel.kind === "tripwire") {
    const w = state.explosives.tripwires.find((x) => x.id === sel.id);
    if (!w) return <div>gone</div>;
    return (
      <>
        <h3 className={s.title}>Tripwire</h3>
        <Line label="from" value={formatPos(w.from)} />
        <Line label="to" value={formatPos(w.to)} />
      </>
    );
  }
  const e = state.exfils.find((x) => x.id === sel.id);
  if (!e) return <div>gone</div>;
  return (
    <>
      <h3 className={s.title}>{e.name}</h3>
      <Line label="kind" value={e.kind} />
      <Line label="status" value={exfilStatus(e.status).label} />
      <Line label="position" value={formatPos(e.pos)} />
    </>
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
function LookSection({ look }: { look: Look }) {
  const { parts, hiddenByGroup } = look;
  return (
    <>
      <h4 className={s.heading}>look</h4>
      {hiddenByGroup && <div className="muted">hidden: its category is off</div>}
      {!parts.length && <div className="muted">no rule matches: its kind's base look</div>}
      <ul className={s.look}>
        {[...parts].reverse().map((c) => (
          <li key={c.rule.id} title={c.rule.query}>
            <span className={s.label}>{c.rule.label || c.rule.id}: </span>
            {c.set.map((k, i) => {
              const one = { ...look.style, ...c.rule.style } as Style;
              return (
                <span key={k} className={c.overridden.includes(k) ? s.overridden : undefined}>
                  {i ? ", " : ""}
                  {PROP_TEXT[k](one)}
                </span>
              );
            })}
            {!c.set.length && <span className="muted">(sets nothing)</span>}
          </li>
        ))}
      </ul>
    </>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className={s.label}>{label}: </span>
      {value}
    </div>
  );
}

/** What a player or corpse carries that a started quest needs (why "Carrying needed items" marks it). */
function NeededSection(props: { nodes: ItemNode[] | undefined; catalog: ItemCatalog; questNeeds: Props["questNeeds"] }) {
  const { nodes, catalog, questNeeds } = props;
  if (!nodes?.length || !questNeeds.size) return null;
  const items = carriedNeededItems(carried(nodes, catalog).tpls, questNeeds);
  if (!items.length) return null;
  return (
    <>
      <h4 className={s.heading}>carrying needed</h4>
      <ul className={s.items}>
        {items.map(({ tpl, count, needs }) => {
          const info = catalog.lookup(tpl);
          return (
            <li key={tpl}>
              <span title={info ? `${info.name}\n${tpl}` : tpl}>{info?.name ?? tpl}</span>
              {count > 1 && <span className="muted"> ×{count}</span>}
              <span className="muted">{` for ${needs.map(formatQuestNeed).join("; ")}`}</span>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function ItemSection(props: { heading: string; nodes: ItemNode[] | undefined; empty: string; catalog: ItemCatalog }) {
  const { heading, nodes, empty, catalog } = props;
  if (!nodes?.length)
    return (
      <>
        <h4 className={s.heading}>{heading}</h4>
        <div className="muted">{empty}</div>
      </>
    );
  const v = equipmentValue(nodes, catalog);
  return (
    <>
      <h4 className={s.heading}>{`${heading} · ${v > 0 ? `${formatPrice(v)} ₽` : "no price data"}`}</h4>
      <ItemTree nodes={nodes} catalog={catalog} />
    </>
  );
}

function ItemTree({ nodes, catalog }: { nodes: ItemNode[]; catalog: ItemCatalog }) {
  return (
    <ul className={s.items}>
      {nodes.map((n, i) => {
        const info = catalog.lookup(n.tpl);
        const base = info?.priceSource === "base";
        return (
          <li key={i}>
            {n.slot && <span className={s.label}>{n.slot}: </span>}
            <span title={info ? `${info.name}\n${n.tpl}` : undefined}>{info?.shortName ?? n.tpl}</span>
            {!!n.count && n.count > 1 && <span className="muted"> ×{n.count}</span>}
            {!!info?.price && (
              <Price base={base}>{` ${formatPrice(info.price * (n.count ?? 1))}`}</Price>
            )}
            {!!n.items?.length && <ItemTree nodes={n.items} catalog={catalog} />}
          </li>
        );
      })}
    </ul>
  );
}

function formatPos(p: WorldPos | null | undefined): string {
  return p ? p.map((v) => v.toFixed(1)).join(", ") : "unknown";
}
