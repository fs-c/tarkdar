// One display rule in the Map view: a compact row (its colour, name, what it sets, how many things it
// matches), opening into an editor for its style. Built-in rules can be changed and reset; standing
// rules (pinned highlights) can also be switched off, moved and removed.

import { ArrowDown, ArrowUp, RotateCcw, Trash2 } from "lucide-react";
import { formatPrice } from "../items";
import { SHOW_LEVELS } from "../rules/defaults";
import type { Emphasis, LabelMode, Rule, StyleProps } from "../rules/rules";
import { Button, Segmented, type SegmentedOption } from "../ui";
import s from "./RuleRow.module.css";

const EMPHASIS_OPTIONS: SegmentedOption<Emphasis>[] = [
  { value: "faint", label: "Faint", title: "Smaller and fainter (plain AI scavs, cheap items)" },
  { value: "normal", label: "Normal" },
  { value: "strong", label: "Strong", title: "Bigger; players get a halo and their name in colour" },
  { value: "loud", label: "Loud", title: "Biggest (bosses)" },
];

/** When it shows, as you zoom out: from a level of detail on, or not at all (null). */
const SHOW_OPTIONS: SegmentedOption<number | null>[] = [
  { value: SHOW_LEVELS.always, label: "Always", title: "At every zoom" },
  { value: SHOW_LEVELS.unlessFar, label: "Unless far", title: "Not when zoomed far out" },
  { value: SHOW_LEVELS.mid, label: "Mid zoom", title: "From a medium zoom on" },
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

const LABEL_OPTIONS: SegmentedOption<LabelMode>[] = [
  { value: "never", label: "None" },
  { value: "room", label: "If room", title: "Where there's room for it" },
  { value: "always", label: "Always", title: "Even on top of other labels" },
];

/** Short text for what a rule sets, besides its colour: "strong · from mid zoom · no label". */
export function summary(r: Pick<Rule, "match" | "style">): string {
  const parts: string[] = [];
  if (r.match.questNeeded) parts.push("a started quest needs it");
  if (r.match.maxValue !== undefined) parts.push(`< ${formatPrice(r.match.maxValue)}`);
  if (r.match.minValue !== undefined) parts.push(`≥ ${formatPrice(r.match.minValue)}`);
  const { emphasis, show, label } = r.style;
  if (emphasis && emphasis !== "normal") parts.push(emphasis);
  if (show !== undefined) parts.push(SHOW_TEXT.get(show) ?? "zoomed in");
  if (label === "never") parts.push("no label");
  if (label === "always") parts.push("always labelled");
  return parts.join(" · ");
}

interface Props {
  rule: Rule;
  open: boolean;
  onOpen: (open: boolean) => void;
  /** Sets style properties (and value bounds). */
  onEdit: (patch: StyleProps & { minValue?: number; maxValue?: number }) => void;
  /** Built-in rules that were changed: back to the default. */
  onReset?: () => void;
  /** How many things it matches now (standing rules). */
  count?: number;
  /** Standing rules: what kind of rule it was made from, and what can be done with it. */
  kind?: string;
  onToggle?: () => void;
  onMove?: (dir: -1 | 1) => void;
  onRemove?: () => void;
}

export function RuleRow({ rule, open, onOpen, onEdit, onReset, count, kind, onToggle, onMove, onRemove }: Props) {
  const { style, match } = rule;
  const on = rule.on !== false;
  return (
    <div className={s.rule} data-open={open} data-on={on}>
      <div className={s.head}>
        {onToggle ? (
          <input type="checkbox" className={s.check} checked={on} onChange={onToggle} title={on ? "On: click to switch off" : "Off: click to switch on"} />
        ) : null}
        <button type="button" className={s.toggle} aria-expanded={open} onClick={() => onOpen(!open)} title={kind ? `${kind}: click to edit` : "Click to edit"}>
          <span className={s.swatch} style={style.color ? { background: style.color } : undefined} data-auto={!style.color} />
          <span className={s.name}>{rule.label}</span>
          <span className={s.summary}>{summary(rule)}</span>
        </button>
        {count !== undefined && <span className={s.count} title="Matching things in the raid now">{count}</span>}
        {onReset && (
          <Button variant="icon" title="Changed: reset to the default" onClick={onReset}>
            <RotateCcw size={13} />
          </Button>
        )}
      </div>
      {open && (
        <div className={s.editor}>
          <Field label="Colour">
            <input type="color" className={s.color} value={style.color ?? "#c0c0c0"} onChange={(e) => onEdit({ color: e.target.value })} />
            {!style.color && <span className="muted">its own (exfils: by status)</span>}
          </Field>
          <Field label="Emphasis">
            <Segmented label="Emphasis" options={EMPHASIS_OPTIONS} value={style.emphasis} onChange={(v) => onEdit({ emphasis: v })} />
          </Field>
          <Field label="Shown">
            <Segmented label="Shown" options={SHOW_OPTIONS} value={style.show} onChange={(v) => onEdit({ show: v })} />
          </Field>
          <Field label="Label">
            <Segmented label="Label" options={LABEL_OPTIONS} value={style.label} onChange={(v) => onEdit({ label: v })} />
          </Field>
          {match.maxValue !== undefined && (
            <Field label="Below">
              <ValueInput value={match.maxValue} onChange={(v) => onEdit({ maxValue: v })} />
            </Field>
          )}
          {match.minValue !== undefined && (
            <Field label="At least">
              <ValueInput value={match.minValue} onChange={(v) => onEdit({ minValue: v })} />
            </Field>
          )}
          {(onMove || onRemove) && (
            <div className={s.actions}>
              {onMove && (
                <>
                  <Button variant="icon" title="Down (rules further down give way to those above)" onClick={() => onMove(-1)}>
                    <ArrowDown size={14} />
                  </Button>
                  <Button variant="icon" title="Up (wins over the rules below)" onClick={() => onMove(1)}>
                    <ArrowUp size={14} />
                  </Button>
                </>
              )}
              {onRemove && (
                <Button title="Remove this rule" onClick={onRemove}>
                  <Trash2 size={13} /> Remove
                </Button>
              )}
            </div>
          )}
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

/** Roubles, entered in thousands. */
function ValueInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <label className={s.value}>
      <input
        type="number"
        min={0}
        step={5}
        value={value / 1000}
        onChange={(e) => {
          const k = Number(e.target.value);
          if (Number.isFinite(k) && k >= 0) onChange(Math.round(k * 1000));
        }}
      />
      k ₽
    </label>
  );
}
