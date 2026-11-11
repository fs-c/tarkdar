// Column definitions per list tab (TanStack Table v9: sorting only; filtering is ours, see rows.ts).

import {
  type ColumnDef,
  type SortingState,
  createColumnHelper,
  createSortedRowModel,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_text,
  tableFeatures,
} from "@tanstack/react-table";
import { formatPrice } from "../items";
import { COLORS, TYPE_COLORS } from "../render";
import { PLAYER_TYPES } from "../roles";
import { Price } from "../ui";
import s from "./columns.module.css";
import type { ContainerRow, ExfilRow, ExplosiveRow, ItemRow, PlayerRow, RowBase, TabId } from "./rows";

export const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric, text: sortFn_text },
});
export type Features = typeof features;

export interface TabDef<R extends RowBase> {
  id: TabId;
  label: string;
  /** CSS grid-template-columns for header and rows. */
  template: string;
  columns: ColumnDef<Features, R, any>[];
  defaultSort: SortingState;
  /** Right-aligned (numeric) column ids. */
  numeric: string[];
}

const price = (v: number | undefined) => (v === undefined ? "" : formatPrice(v));

function distanceColumns<R extends RowBase>() {
  const h = createColumnHelper<Features, R>();
  return [
    h.accessor((r) => r.dist, {
      id: "dist",
      header: "dist",
      cell: (c) => (c.getValue() === undefined ? "" : `${Math.round(c.getValue()!)} m`),
      sortUndefined: "last",
    }),
    h.accessor((r) => r.dh, {
      id: "dh",
      header: "Δh",
      cell: (c) => heightText(c.getValue()),
      sortUndefined: "last",
    }),
  ];
}

export function heightText(dh: number | undefined): string {
  if (dh === undefined || Math.abs(dh) < 2) return "";
  return dh > 0 ? `▲${Math.round(dh)}` : `▼${Math.round(-dh)}`;
}

const dotColor = (r: PlayerRow) => (r.state === "dead" ? COLORS.dead : TYPE_COLORS[r.type]);
/** Sorts by type (PLAYER_TYPES order), then label. */
const typeSortKey = (r: PlayerRow) => `${String(PLAYER_TYPES.indexOf(r.type)).padStart(2, "0")} ${r.typeLabel}`;

const p = createColumnHelper<Features, PlayerRow>();
const players: TabDef<PlayerRow> = {
  id: "players",
  label: "Players",
  template: "minmax(70px, 1fr) minmax(80px, 1.3fr) 50px 56px 52px 40px",
  columns: [
    p.accessor((r) => (r.local ? -1 : r.sel.id), {
      id: "name",
      header: "player",
      cell: (c) => (
        <span className={c.row.original.state === "alive" ? undefined : "muted"}>
          <span className={s.dot} style={{ background: dotColor(c.row.original) }} />
          {c.row.original.name}
        </span>
      ),
    }),
    p.accessor(typeSortKey, {
      id: "type",
      header: "type",
      sortFn: "text",
      cell: (c) => {
        const r = c.row.original;
        return (
          <span title={r.typeDetail} className={r.type === "boss" ? s.boss : undefined} style={{ color: TYPE_COLORS[r.type] }}>
            {r.typeLabel}
          </span>
        );
      },
    }),
    p.accessor("state", { header: "state", sortFn: "text" }),
    p.accessor("value", { header: "gear ₽", cell: (c) => <Price>{price(c.getValue())}</Price>, sortUndefined: "last", sortDescFirst: true }),
    ...distanceColumns<PlayerRow>(),
  ],
  defaultSort: [{ id: "dist", desc: false }],
  numeric: ["value", "dist", "dh"],
};

const i = createColumnHelper<Features, ItemRow>();
const items: TabDef<ItemRow> = {
  id: "items",
  label: "Items",
  template: "minmax(120px, 1fr) 50px 56px 52px 40px",
  columns: [
    i.accessor("shortName", {
      header: "item",
      sortFn: "text",
      cell: (c) => (
        <span title={c.row.original.name} className={c.row.original.kind === "quest" ? s.quest : undefined}>
          {c.getValue()}
        </span>
      ),
    }),
    i.accessor("kind", { header: "kind", sortFn: "text" }),
    i.accessor("price", {
      header: "₽",
      sortUndefined: "last",
      sortDescFirst: true,
      cell: (c) => (
        <Price base={c.row.original.basePrice}>{price(c.getValue())}</Price>
      ),
    }),
    ...distanceColumns<ItemRow>(),
  ],
  defaultSort: [{ id: "price", desc: true }],
  numeric: ["price", "dist", "dh"],
};

const k = createColumnHelper<Features, ContainerRow>();
const containers: TabDef<ContainerRow> = {
  id: "containers",
  label: "Containers",
  template: "minmax(90px, 1fr) 40px 56px 52px 40px",
  columns: [
    k.accessor("name", { header: "container", sortFn: "text", cell: (c) => <span title={`${c.getValue()} (${c.row.original.kind})`}>{c.getValue()}</span> }),
    k.accessor("count", { header: "#", sortDescFirst: true }),
    k.accessor("value", { header: "₽", sortUndefined: "last", sortDescFirst: true, cell: (c) => <Price>{price(c.getValue())}</Price> }),
    ...distanceColumns<ContainerRow>(),
  ],
  defaultSort: [{ id: "value", desc: true }],
  numeric: ["count", "value", "dist", "dh"],
};

const e = createColumnHelper<Features, ExfilRow>();
const exfils: TabDef<ExfilRow> = {
  id: "exfils",
  label: "Exfils",
  template: "minmax(60px, 1fr) 60px 90px 52px 40px",
  columns: [
    // Long names lose their start rather than their end (the distinguishing part tends to be last).
    e.accessor("name", {
      header: "exfil",
      sortFn: "text",
      cell: (c) => (
        <span className={s.cutLeft} title={c.getValue()}>
          <bdi>{c.getValue()}</bdi>
        </span>
      ),
    }),
    e.accessor("kind", { header: "kind", sortFn: "text" }),
    e.accessor("status", {
      header: "status",
      sortFn: "text",
      cell: (c) => (
        <span className={s.tone} data-tone={c.row.original.kind === "secret" ? "secret" : c.row.original.tone}>
          {c.getValue()}
        </span>
      ),
    }),
    ...distanceColumns<ExfilRow>(),
  ],
  defaultSort: [{ id: "dist", desc: false }],
  numeric: ["dist", "dh"],
};

const x = createColumnHelper<Features, ExplosiveRow>();
const explosives: TabDef<ExplosiveRow> = {
  id: "explosives",
  label: "Explosives",
  template: "minmax(90px, 1fr) 60px 52px 40px",
  columns: [
    x.accessor("kind", { header: "kind", sortFn: "text" }),
    x.accessor("length", { header: "length", sortUndefined: "last", cell: (c) => (c.getValue() === undefined ? "" : `${c.getValue()!.toFixed(1)} m`) }),
    ...distanceColumns<ExplosiveRow>(),
  ],
  defaultSort: [{ id: "dist", desc: false }],
  numeric: ["length", "dist", "dh"],
};

export const TABS = { players, items, containers, exfils, explosives } as const;
export const TAB_ORDER: TabId[] = ["players", "items", "containers", "exfils", "explosives"];
