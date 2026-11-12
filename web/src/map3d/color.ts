// Colour conversion for the baked vertex colours. The lift that turns game colours into map
// colours is in the shader (stage.ts, settings.ts ColorGrade).

const SRGB_TO_LINEAR = new Uint8Array(256);
for (let v = 0; v < 256; v++) {
  const c = v / 255;
  SRGB_TO_LINEAR[v] = Math.round(255 * (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
}

/** sRGB bytes -> linear bytes (what three.js expects in a colour attribute); alpha unchanged. */
export function srgbBytesToLinear(srgb: Uint8Array): Uint8Array {
  const out = new Uint8Array(srgb.length);
  for (let i = 0; i < srgb.length; i += 4) {
    out[i] = SRGB_TO_LINEAR[srgb[i]!]!;
    out[i + 1] = SRGB_TO_LINEAR[srgb[i + 1]!]!;
    out[i + 2] = SRGB_TO_LINEAR[srgb[i + 2]!]!;
    out[i + 3] = srgb[i + 3]!;
  }
  return out;
}
