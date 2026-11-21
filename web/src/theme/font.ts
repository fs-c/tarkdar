// Canvas fonts: a size and a weight, the family from the theme. The one place a font string is built.

import { getTheme } from "./current";

export interface CanvasFont {
  /** px */
  size: number;
  bold?: boolean;
}

export const canvasFont = ({ size, bold }: CanvasFont, family = getTheme().fonts.canvas): string => `${bold ? "bold " : ""}${size}px ${family}`;

/** Box height for text in this font: its size, plus a little. */
export const textBoxHeight = (font: CanvasFont): number => font.size + 2;

// Text widths measured on the canvas, per font string and text. Dropped when a font could have changed.
const widths = new Map<string, number>();

export function textWidth(ctx: CanvasRenderingContext2D, font: CanvasFont, text: string): number {
  const str = canvasFont(font);
  const key = `${str}|${text}`;
  let w = widths.get(key);
  if (w === undefined) {
    ctx.font = str;
    w = ctx.measureText(text).width;
    widths.set(key, w);
  }
  return w;
}

export const clearTextWidths = (): void => widths.clear();
