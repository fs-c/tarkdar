// Material colours from the game are albedo-texture means: dark on average
// (median luma ~0.3) and uneven. For a map they are lifted and compressed
// into a narrower, lighter range, keeping the hue.

/** Output luma = LIFT + GAIN * input luma (sRGB, 0..1). */
export const LIFT = 0.36;
export const GAIN = 0.58;

/** Lift one sRGB colour (bytes) in place at `offset`. */
export function liftColor(rgb: Uint8Array | Uint8ClampedArray | number[], offset = 0): void {
  const r = rgb[offset]! / 255;
  const g = rgb[offset + 1]! / 255;
  const b = rgb[offset + 2]! / 255;
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const target = LIFT + GAIN * luma;
  // Scale towards the target luma; very dark colours have no usable hue, so
  // they are blended with grey instead of being multiplied up.
  const hue = Math.min(1, luma / 0.12);
  const scale = target / Math.max(luma, 1e-3);
  const out = (c: number) => Math.round(255 * Math.min(1, hue * c * scale + (1 - hue) * target));
  rgb[offset] = out(r);
  rgb[offset + 1] = out(g);
  rgb[offset + 2] = out(b);
}

/** Mix a colour towards its own grey; amount 0 = unchanged, 1 = grey. In place. */
export function desaturate(rgb: Uint8Array | Uint8ClampedArray | number[], amount: number, offset = 0): void {
  const grey = 0.2126 * rgb[offset]! + 0.7152 * rgb[offset + 1]! + 0.0722 * rgb[offset + 2]!;
  for (let c = 0; c < 3; c++) rgb[offset + c] = Math.round(rgb[offset + c]! + (grey - rgb[offset + c]!) * amount);
}

const SRGB_TO_LINEAR = new Uint8Array(256);
for (let v = 0; v < 256; v++) {
  const c = v / 255;
  SRGB_TO_LINEAR[v] = Math.round(255 * (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
}

/** sRGB bytes -> linear bytes (what three.js expects in a colour attribute); alpha unchanged. */
export function srgbBytesToLinear(srgb: Uint8Array, lift = false): Uint8Array {
  const out = new Uint8Array(srgb.length);
  const tmp: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < srgb.length; i += 4) {
    tmp[0] = srgb[i]!;
    tmp[1] = srgb[i + 1]!;
    tmp[2] = srgb[i + 2]!;
    if (lift) liftColor(tmp);
    out[i] = SRGB_TO_LINEAR[tmp[0]]!;
    out[i + 1] = SRGB_TO_LINEAR[tmp[1]]!;
    out[i + 2] = SRGB_TO_LINEAR[tmp[2]]!;
    out[i + 3] = srgb[i + 3]!;
  }
  return out;
}
