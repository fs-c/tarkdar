// Details panel for a selected player, loot entry or exfil.

import type { RadarState } from "../connection";
import { type ItemCatalog, containerName, exfilStatus, formatPrice, totalValue } from "../items";
import type { Selection } from "../pick";
import type { ItemNode, WorldPos } from "../protocol";

interface Props {
  selection: Selection;
  state: RadarState;
  catalog: ItemCatalog;
}

export function DetailsPanel(props: Props) {
  return (
    <div id="details">
      <Details {...props} />
    </div>
  );
}

function Details({ selection: sel, state, catalog }: Props) {
  if (sel.kind === "player") {
    const p = state.players.find((x) => x.id === sel.id);
    if (!p) return <div>player gone</div>;
    const eq = state.equipment.get(p.id);
    return (
      <>
        <h3>{p.local ? `You (#${p.id})` : `Player #${p.id}`}</h3>
        <Line label="side" value={p.side + (p.ai ? " (AI)" : "")} />
        {p.voice && <Line label="voice" value={p.voice} />}
        {p.kind && <Line label="kind" value={p.kind} />}
        <Line label="state" value={p.dead ? "dead" : p.absent ? "left the raid" : "alive"} />
        <Line label="position" value={formatPos(p.pos)} />
        <ItemSection heading="equipment" nodes={eq?.slots} empty="not read (yet)" catalog={catalog} />
      </>
    );
  }
  if (sel.kind === "loot") {
    const l = state.loot.find((x) => x.id === sel.id);
    if (!l) return <div>gone</div>;
    const info = l.kind === "container" ? undefined : catalog.lookup(l.tpl);
    const name = l.kind === "container" ? containerName(l.tpl) : info?.name;
    return (
      <>
        <h3>{name ?? l.kind}</h3>
        <Line label="kind" value={l.kind} />
        {!!info?.price && (
          <Line label="price" value={`${formatPrice(info.price)} ₽${info.priceSource === "base" ? " (base price)" : ""}`} />
        )}
        {l.tpl && <Line label="template" value={l.tpl} />}
        <Line label="object" value={l.obj} />
        <Line label="position" value={formatPos(l.pos)} />
        {(l.kind === "container" || l.kind === "corpse") && (
          <ItemSection
            heading={l.kind === "corpse" ? "equipment" : "contents"}
            nodes={l.contents}
            empty="empty (or not readable)"
            catalog={catalog}
          />
        )}
      </>
    );
  }
  const e = state.exfils.find((x) => x.id === sel.id);
  if (!e) return <div>gone</div>;
  return (
    <>
      <h3>{e.name}</h3>
      <Line label="kind" value={e.kind} />
      <Line label="status" value={exfilStatus(e.status).label} />
      <Line label="position" value={formatPos(e.pos)} />
    </>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="label">{label}: </span>
      {value}
    </div>
  );
}

function ItemSection(props: { heading: string; nodes: ItemNode[] | undefined; empty: string; catalog: ItemCatalog }) {
  const { heading, nodes, empty, catalog } = props;
  if (!nodes?.length)
    return (
      <>
        <h4>{heading}</h4>
        <div className="muted">{empty}</div>
      </>
    );
  const v = totalValue(nodes, catalog);
  return (
    <>
      <h4>{`${heading} · ${v > 0 ? `${formatPrice(v)} ₽` : "no price data"}`}</h4>
      <ItemTree nodes={nodes} catalog={catalog} />
    </>
  );
}

function ItemTree({ nodes, catalog }: { nodes: ItemNode[]; catalog: ItemCatalog }) {
  return (
    <ul className="items">
      {nodes.map((n, i) => {
        const info = catalog.lookup(n.tpl);
        const base = info?.priceSource === "base";
        return (
          <li key={i}>
            {n.slot && <span className="label">{n.slot}: </span>}
            <span title={info ? `${info.name}\n${n.tpl}` : undefined}>{info?.shortName ?? n.tpl}</span>
            {!!n.count && n.count > 1 && <span className="muted"> ×{n.count}</span>}
            {!!info?.price && (
              <span className={base ? "price base" : "price"} title={base ? "base price (no flea data)" : undefined}>
                {` ${formatPrice(info.price * (n.count ?? 1))}`}
              </span>
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
