import type { ButtonHTMLAttributes } from "react";
import s from "./Button.module.css";
import { cx } from "./cx";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "icon" | "link";
}

export function Button({ variant = "default", className, ...rest }: Props) {
  return (
    <button
      type="button"
      className={cx(s.button, variant !== "default" && s[variant], className)}
      {...rest}
    />
  );
}
