import s from "./Switch.module.css";
import { cx } from "./cx";

interface Props {
  checked: boolean;
  onChange: () => void;
  /** "sm": in dense rows (rule lists, group headers). */
  size?: "md" | "sm";
  title?: string;
  className?: string;
}

/** An on/off switch on its own; with a label and hint, see ToggleRow. */
export function Switch({ checked, onChange, size = "md", title, className }: Props) {
  return (
    <input type="checkbox" role="switch" className={cx(s.switch, size === "sm" && s.sm, className)} checked={checked} onChange={onChange} title={title} />
  );
}
