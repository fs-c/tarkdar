// One display rule in the Filters view: a compact row (on/off, its colour, name, query, how many things it
// matches), opening into an editor: name, query (highlight/query.ts), style. Hovering it marks what it
// matches on the map.

import { ArrowDown, ArrowUp, Copy, Pin, Trash2 } from "lucide-react";
import { CATEGORIES, SHOW_LEVELS } from "../rules/defaults";
import type { Emphasis, LabelMode, StyleProps } from "../rules/rules";
import type { StoredRule } from "../rules/store";
import { Button, Segmented, type SegmentedOption } from "../ui";
import s from "./RuleRow.module.css";

const EMPHASIS_OPTIONS: SegmentedOption<Emphasis | undefined>[] = [
  { value: undefined, label: "—", title: "Leave it to the rules below" },
  { value: "faint", label: "Faint", title: "Smaller and fainter (plain AI scavs, cheap items)" },
  { value: "normal", label: "Normal" },
  { value: "strong", label: "Strong", title: "Bigger; players get a halo and their name in colour" },
  { value: "loud", label: "Loud", title: "Biggest (bosses)" },
];

/** When it shows, as you zoom out: from a level of detail on, or not at all (null). */
const SHOW_OPTIONS: SegmentedOption<number | null | undefined>[] = [
  { value: undefined, label: "—", title: "Leave it to the rules below" },
  { value: SHOW_LEVELS.always, label: "Always", title: "At every zoom" },
  { value: SHOW_LEVELS.unlessFar, label: "Unless far", title: "Not when zoomed far out" },
  { value: SHOW_LEVELS.mid, label: "Mid", title: "From a medium zoom on" },
  { value: SHOW_LEVELS.close, label: "Close", title: "Only zoomed in close" },
  { value: null, label: "Hidden", title: "Never" },
];

const SHOW_TEXT = new Map<number | null, string>([
  [SHOW_LEVELS.always, "always shown"],
  [SHOW_LEVELS.unlessFar, "unless far"],
  [SHOW_LEVELS.mid, "from mid zoom"],
  [SHOW_LEVELS.close, "close up"],
  [null, "hidden"],
]);

const LABEL_OPTIONS: SegmentedOption<LabelMode | undefined>[] = [
  { value: undefined, label: "—", title: "Leave it to the rules below" },
  { value: "never", label: "None" },
  { value: "room", label: "If room", title: "Where there's room for it" },
  { value: "always", label: "Always", title: "Even on top of other labels" },
];

/** Short text for what a rule sets, besides its colour: "ringed · strong · from mid zoom · no label". */
export function summary(style: StyleProps): string {
  const parts: string[] = [];
  if (style.ring) parts.push("ringed");
  if (style.emphasis && style.emphasis !== "normal") parts.push(style.emphasis);
  if (style.show !== undefined) parts.push(SHOW_TEXT.get(style.show) ?? "zoomed in");
  if (style.label === "never") parts.push("no label");
  if (style.label === "always") parts.push("always labelled");
  return parts.join(" · ");
}

interface Props {
  rule: StoredRule;
  open: boolean;
  onOpen: (open: boolean) => void;
  onChange: (patch: Partial<StoredRule>) => void;
  /** How many things it matches now. */
  count: number;
  /** What's wrong with its query. */
  errors: readonly string[];
  /** Marks (or stops marking) what it matches on the map. */
  onHover: (on: boolean) => void;
  onMove: (dir: -1 | 1) => void;
  onDuplicate?: () => void;
  onRemove: () => void;
  /** Pinned: keep it as a rule of its category. */
  onKeep?: () => void;
  /** Its category can be picked (pinned rules: where it goes when kept). */
  pickCategory?: boolean;
}

export function RuleRow({ rule, open, onOpen, onChange, count, errors, onHover, onMove, onDuplicate, onRemove, onKeep, pickCategory = true }: Props) {
  const { style } = rule;
  const setStyle = (patch: StyleProps) => {
    const next: StyleProps = { ...style, ...patch };
    for (const k of Object.keys(patch) as (keyof StyleProps)[]) if (patch[k] === undefined) delete next[k];
    onChange({ style: next });
  };
  // Ringed: the ring around its colour.
  const swatch: React.CSSProperties = { ...(style.color ? { background: style.color } : {}), ...(style.ring ? { boxShadow: `0 0 0 2px ${style.ring}` } : {}) };
  return (
    <div className={s.rule} data-open={open} data-on={rule.on} onPointerEnter={() => onHover(true)} onPointerLeave={() => onHover(false)}>
      <div className={s.head}>
        <input type="checkbox" className={s.check} checked={rule.on} onChange={() => onChange({ on: !rule.on })} title={rule.on ? "On: click to switch off" : "Off: click to switch on"} />
        <button type="button" className={s.toggle} aria-expanded={open} onClick={() => onOpen(!open)} title={`${rule.query || "(no query)"}\nClick to edit`}>
          <span className={s.swatch} style={swatch} data-auto={!style.color} />
          <span className={s.name}>{rule.label || "(unnamed)"}</span>
          <span className={s.summary}>{errors.length ? <span className={s.error}>{errors[0]}</span> : summary(style)}</span>
        </button>
        <span className={s.count} title="Matching things in the raid now">{count}</span>
        {onKeep && (
          <Button variant="icon" title="Keep: a rule of its own, beyond this raid" onClick={onKeep}>
            <Pin size={13} />
          </Button>
        )}
      </div>
      {open && (
        <div className={s.editor}>
          <Field label="Name">
            <input className={s.text} value={rule.label} onChange={(e) => onChange({ label: e.target.value })} />
          </Field>
          {pickCategory && (
            <Field label={onKeep ? "Kept in" : "Category"}>
              <select value={rule.category} title="Where it's listed (General wins over the others)" onChange={(e) => onChange({ category: e.target.value as StoredRule["category"] })}>
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </Field>
          )}
          <Field label="Matches">
            <input
              className={s.query}
              value={rule.query}
              spellCheck={false}
              placeholder="is:boss · item:LEDX · cat:Electronics · value>=40k · pen>=40 · class>=5"
              data-error={errors.length > 0}
              onChange={(e) => onChange({ query: e.target.value })}
            />
          </Field>
          {errors.length > 0 && (
            <Field label="">
              <span className={s.error}>{errors.join("; ")}</span>
            </Field>
          )}
          <Field label="Colour">
            <input type="color" className={s.color} value={style.color ?? "#c0c0c0"} onChange={(e) => setStyle({ color: e.target.value })} />
            {style.color ? (
              <Button variant="link" title="Leave the colour to the rules below (or the thing's own: exfils by status)" onClick={() => setStyle({ color: undefined })}>
                clear
              </Button>
            ) : (
              <span className="muted">from below (exfils: by status)</span>
            )}
          </Field>
          <Field label="Ring">
            <input type="checkbox" checked={!!style.ring} onChange={() => setStyle({ ring: style.ring ? undefined : (style.color ?? "#ff8a3d") })} title="A ring around it; loot labelled at any zoom; shown even where its category is off" />
            {style.ring && <input type="color" className={s.color} value={style.ring} onChange={(e) => setStyle({ ring: e.target.value })} />}
            <span className="muted">labelled, and shown even where its category is off</span>
          </Field>
          <Field label="Emphasis">
            <Segmented label="Emphasis" options={EMPHASIS_OPTIONS} value={style.emphasis} onChange={(v) => setStyle({ emphasis: v })} />
          </Field>
          <Field label="Shown">
            <Segmented label="Shown" options={SHOW_OPTIONS} value={style.show} onChange={(v) => setStyle({ show: v })} />
          </Field>
          <Field label="Label">
            <Segmented label="Label" options={LABEL_OPTIONS} value={style.label} onChange={(v) => setStyle({ label: v })} />
          </Field>
          <div className={s.actions}>
            <Button variant="icon" title="Down (gives way to the rules above)" onClick={() => onMove(-1)}>
              <ArrowDown size={14} />
            </Button>
            <Button variant="icon" title="Up (wins over the rules below)" onClick={() => onMove(1)}>
              <ArrowUp size={14} />
            </Button>
            {onDuplicate && (
              <Button variant="icon" title="Duplicate" onClick={onDuplicate}>
                <Copy size={13} />
              </Button>
            )}
            <Button title="Remove this rule" onClick={onRemove}>
              <Trash2 size={13} /> Remove
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={s.field}>
      <span className={s.caption}>{label}</span>
      <span className={s.control}>{children}</span>
    </div>
  );
}
