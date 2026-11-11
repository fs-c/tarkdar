// Image metrics on RGBA byte buffers of equal size. No dependencies.

/** Rec. 601 luma, one float per pixel. */
export function luma(rgba, width, height) {
  const out = new Float32Array(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
  }
  return out;
}

/** Peak signal-to-noise ratio over RGB in dB (Infinity for identical images). */
export function psnr(a, b) {
  let sum = 0;
  let n = 0;
  for (let p = 0; p < a.length; p += 4) {
    for (let c = 0; c < 3; c++) {
      const d = a[p + c] - b[p + c];
      sum += d * d;
    }
    n += 3;
  }
  return sum === 0 ? Infinity : 10 * Math.log10((255 * 255) / (sum / n));
}

/**
 * Mean structural similarity (Wang et al. 2004) on luma, over non-overlapping
 * `window`-pixel blocks. 1 = identical; sensitive to missing or displaced
 * structure, tolerant of small uniform brightness changes.
 */
export function ssim(a, b, width, height, window = 8) {
  const la = luma(a, width, height);
  const lb = luma(b, width, height);
  const c1 = (0.01 * 255) ** 2;
  const c2 = (0.03 * 255) ** 2;
  let total = 0;
  let blocks = 0;
  for (let y = 0; y + window <= height; y += window) {
    for (let x = 0; x + window <= width; x += window) {
      let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
      for (let dy = 0; dy < window; dy++) {
        let i = (y + dy) * width + x;
        for (let dx = 0; dx < window; dx++, i++) {
          const va = la[i], vb = lb[i];
          sa += va;
          sb += vb;
          saa += va * va;
          sbb += vb * vb;
          sab += va * vb;
        }
      }
      const n = window * window;
      const ma = sa / n, mb = sb / n;
      const varA = saa / n - ma * ma;
      const varB = sbb / n - mb * mb;
      const cov = sab / n - ma * mb;
      total += ((2 * ma * mb + c1) * (2 * cov + c2)) / ((ma * ma + mb * mb + c1) * (varA + varB + c2));
      blocks++;
    }
  }
  return blocks ? total / blocks : 1;
}

/** Fraction of pixels whose largest channel difference exceeds `threshold`. */
export function changedFraction(a, b, threshold = 8) {
  let changed = 0;
  for (let p = 0; p < a.length; p += 4) {
    const d = Math.max(Math.abs(a[p] - b[p]), Math.abs(a[p + 1] - b[p + 1]), Math.abs(a[p + 2] - b[p + 2]));
    if (d > threshold) changed++;
  }
  return changed / (a.length / 4);
}
