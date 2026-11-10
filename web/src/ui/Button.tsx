import type { ButtonHTMLAttributes } from "react";
import s from "./Button.module.css";
import { cx } from "./cx";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "primary" | "icon" | "link";
  /** A toggle: sets aria-pressed, and the accent look while on. */
  pressed?: boolean;
}

export function Button({ variant = "default", pressed, className, ...rest }: Props) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      className={cx(s.button, variant !== "default" && s[variant], className)}
      {...rest}
    />
  );
}
