import assert from "node:assert/strict";
import { test } from "node:test";
import { changedFraction, psnr, ssim } from "./metrics.mjs";

function image(width, height, fn) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = fn(x, y);
      data.set([v, v, v, 255], (y * width + x) * 4);
    }
  }
  return data;
}

const W = 64, H = 48;
const checker = image(W, H, (x, y) => (((x >> 3) + (y >> 3)) % 2 ? 200 : 40));

test("identical images", () => {
  assert.equal(psnr(checker, checker), Infinity);
  assert.equal(ssim(checker, checker, W, H), 1);
  assert.equal(changedFraction(checker, checker), 0);
});

test("uniform brightness shift keeps structure", () => {
  const brighter = image(W, H, (x, y) => (((x >> 3) + (y >> 3)) % 2 ? 210 : 50));
  assert.ok(Math.abs(psnr(checker, brighter) - 28.13) < 0.01);
  assert.ok(ssim(checker, brighter, W, H) > 0.98);
  assert.equal(changedFraction(checker, brighter, 8), 1);
  assert.equal(changedFraction(checker, brighter, 10), 0);
});

test("missing structure lowers ssim", () => {
  const stripes = image(W, H, (x) => (x % 4 < 2 ? 200 : 40));
  const flat = image(W, H, () => 120);
  assert.ok(ssim(stripes, flat, W, H) < 0.05);
  const half = image(W, H, (x) => (x < W / 2 ? (x % 4 < 2 ? 200 : 40) : 120));
  const s = ssim(stripes, half, W, H);
  assert.ok(s > 0.45 && s < 0.6, String(s));
  assert.equal(changedFraction(stripes, half), 0.5);
});
