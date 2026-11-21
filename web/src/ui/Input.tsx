import type { ComponentProps } from "react";
import s from "./Input.module.css";
import { cx } from "./cx";

/** A text field (also search). Mark a bad value with aria-invalid. */
export function TextInput({ className, ...rest }: ComponentProps<"input">) {
  return <input type="text" className={cx(s.field, className)} {...rest} />;
}

export function TextArea({ className, ...rest }: ComponentProps<"textarea">) {
  return <textarea className={cx(s.field, className)} {...rest} />;
}

/** A colour picker's swatch. */
export function ColorInput({ className, ...rest }: Omit<ComponentProps<"input">, "type">) {
  return <input type="color" className={cx(s.color, className)} {...rest} />;
}
