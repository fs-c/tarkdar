// Details panel for a selected player, loot entry or exfil.

import { type ItemCatalog, containerName, exfilStatus, formatPrice, totalValue } from "./items";
import type { Exfil, ItemNode, LootEntry, Player, PlayerEquipment } from "./protocol";

export type Selection =
  | { kind: "player"; id: number }
  | { kind: "loot"; id: number }
  | { kind: "exfil"; id: number };

export interface DetailsSource {
  players: Player[];
  loot: LootEntry[];
  exfils: Exfil[];
  equipment: Map<number, PlayerEquipment>;
}

export function renderDetails(panel: HTMLElement, sel: Selection | null, src: DetailsSource, catalog: ItemCatalog): void {
  panel.replaceChildren();
  panel.hidden = sel === null;
  if (!sel) return;

  const title = (text: string) => panel.append(el("h3", text));
  const line = (label: string, value: string) => {
    const p = el("div");
    p.append(el("span", `${label}: `, "label"), document.createTextNode(value));
    panel.append(p);
  };
  const pos = (p: [number, number, number] | null | undefined) => (p ? p.map((v) => v.toFixed(1)).join(", ") : "unknown");

  if (sel.kind === "player") {
    const p = src.players.find((x) => x.id === sel.id);
    if (!p) return void panel.append(el("div", "player gone"));
    title(p.local ? `You (#${p.id})` : `Player #${p.id}`);
    line("side", p.side + (p.ai ? " (AI)" : ""));
    line("state", p.dead ? "dead" : p.absent ? "left the raid" : "alive");
    line("position", pos(p.pos));
    const eq = src.equipment.get(p.id);
    panel.append(el("h4", eq?.slots.length ? `equipment · ${valueText(eq.slots, catalog)}` : "equipment"));
    panel.append(eq?.slots.length ? itemTree(eq.slots, catalog) : el("div", "not read (yet)", "muted"));
  } else if (sel.kind === "loot") {
    const l = src.loot.find((x) => x.id === sel.id);
    if (!l) return void panel.append(el("div", "gone"));
    const info = l.kind === "container" ? undefined : catalog.lookup(l.tpl);
    const name = l.kind === "container" ? containerName(l.tpl) : info?.name;
    title(name ?? l.kind);
    line("kind", l.kind);
    if (info?.price) line("price", `${formatPrice(info.price)} ₽${info.priceSource === "base" ? " (base price)" : ""}`);
    if (l.tpl) line("template", l.tpl);
    line("object", l.obj);
    line("position", pos(l.pos));
    if (l.kind === "container" || l.kind === "corpse") {
      const heading = l.kind === "corpse" ? "equipment" : "contents";
      panel.append(el("h4", l.contents?.length ? `${heading} · ${valueText(l.contents, catalog)}` : heading));
      panel.append(l.contents?.length ? itemTree(l.contents, catalog) : el("div", "empty (or not readable)", "muted"));
    }
  } else {
    const e = src.exfils.find((x) => x.id === sel.id);
    if (!e) return void panel.append(el("div", "gone"));
    title(e.name);
    line("kind", e.kind);
    line("status", exfilStatus(e.status).label);
    line("position", pos(e.pos));
  }
}

function itemTree(nodes: ItemNode[], catalog: ItemCatalog): HTMLElement {
  const ul = el("ul", undefined, "items");
  for (const n of nodes) {
    const li = el("li");
    const info = catalog.lookup(n.tpl);
    if (n.slot) li.append(el("span", `${n.slot}: `, "label"));
    const name = el("span", info?.shortName ?? n.tpl);
    if (info) name.title = `${info.name}\n${n.tpl}`;
    li.append(name);
    if (n.count && n.count > 1) li.append(el("span", ` ×${n.count}`, "muted"));
    if (info?.price) {
      const price = el("span", ` ${formatPrice(info.price * (n.count ?? 1))}`, info.priceSource === "base" ? "price base" : "price");
      if (info.priceSource === "base") price.title = "base price (no flea data)";
      li.append(price);
    }
    if (n.items?.length) li.append(itemTree(n.items, catalog));
    ul.append(li);
  }
  return ul;
}

function valueText(nodes: ItemNode[], catalog: ItemCatalog): string {
  const v = totalValue(nodes, catalog);
  return v > 0 ? `${formatPrice(v)} ₽` : "no price data";
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}
