#!/usr/bin/env node
// Compare a candidate capture against a reference capture, view by view.
//
//   node compare.mjs runs/customs-reference runs/customs-candidate [--diff runs/diff]
//
// Prints SSIM / PSNR / changed pixels per view and the triangle and draw-call
// ratios; writes <candidate>/compare.json. --diff also writes heat-map PNGs.

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { PNG } from "pngjs";
import { changedFraction, psnr, ssim } from "./metrics.mjs";

const { values: opt, positionals } = parseArgs({ options: { diff: { type: "string" } }, allowPositionals: true });
const [refDir, candDir] = positionals;
if (!refDir || !candDir) {
  console.error("usage: node compare.mjs <referenceDir> <candidateDir> [--diff <dir>]");
  process.exit(2);
}

const readRun = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8"));
const ref = readRun(refDir);
const cand = readRun(candDir);
const candByName = new Map(cand.results.map((r) => [r.name, r]));
if (opt.diff) fs.mkdirSync(opt.diff, { recursive: true });

function heatMap(a, b, width, height) {
  const out = new PNG({ width, height });
  for (let p = 0; p < a.length; p += 4) {
    const d = Math.max(Math.abs(a[p] - b[p]), Math.abs(a[p + 1] - b[p + 1]), Math.abs(a[p + 2] - b[p + 2]));
    const grey = (a[p] + a[p + 1] + a[p + 2]) / 12;   // dim reference underneath
    out.data[p] = Math.min(255, grey + d * 3);
    out.data[p + 1] = grey;
    out.data[p + 2] = grey;
    out.data[p + 3] = 255;
  }
  return PNG.sync.write(out);
}

const rows = [];
for (const r of ref.results) {
  const c = candByName.get(r.name);
  if (!c) continue;
  const a = PNG.sync.read(fs.readFileSync(path.join(refDir, r.file)));
  const b = PNG.sync.read(fs.readFileSync(path.join(candDir, c.file)));
  if (a.width !== b.width || a.height !== b.height) throw new Error(`${r.name}: image sizes differ`);
  rows.push({
    name: r.name,
    ssim: ssim(a.data, b.data, a.width, a.height),
    psnr: psnr(a.data, b.data),
    changed: changedFraction(a.data, b.data),
    triangles: [r.triangles, c.triangles],
    calls: [r.calls, c.calls],
    renderMs: [r.renderMs, c.renderMs],
  });
  if (opt.diff) fs.writeFileSync(path.join(opt.diff, r.file), heatMap(a.data, b.data, a.width, a.height));
}
if (!rows.length) throw new Error("no common views");

const fmt = (v, digits) => (Number.isFinite(v) ? v.toFixed(digits) : "inf");
const pct = (pair) => `${((100 * pair[1]) / Math.max(1, pair[0])).toFixed(0)}%`;
console.log(`reference ${ref.data} (${ref.profile})  vs  candidate ${cand.data} (${cand.profile})`);
console.log(`${"view".padEnd(34)} ${"ssim".padStart(6)} ${"psnr".padStart(6)} ${"changed".padStart(8)} ${"tris".padStart(11)} ${"".padStart(5)} ${"calls".padStart(6)} ${"".padStart(5)}`);
for (const r of rows) {
  console.log(
    `${r.name.padEnd(34)} ${fmt(r.ssim, 3).padStart(6)} ${fmt(r.psnr, 1).padStart(6)} ${(100 * r.changed).toFixed(1).padStart(7)}% ` +
      `${String(r.triangles[1]).padStart(11)} ${pct(r.triangles).padStart(5)} ${String(r.calls[1]).padStart(6)} ${pct(r.calls).padStart(5)}`,
  );
}
const mean = (f) => rows.reduce((s, r) => s + f(r), 0) / rows.length;
const summary = {
  views: rows.length,
  meanSsim: mean((r) => r.ssim),
  minSsim: Math.min(...rows.map((r) => r.ssim)),
  meanChanged: mean((r) => r.changed),
  maxTriangles: [Math.max(...rows.map((r) => r.triangles[0])), Math.max(...rows.map((r) => r.triangles[1]))],
  maxCalls: [Math.max(...rows.map((r) => r.calls[0])), Math.max(...rows.map((r) => r.calls[1]))],
};
console.log(
  `mean ssim ${summary.meanSsim.toFixed(3)}, min ${summary.minSsim.toFixed(3)}; max triangles ${summary.maxTriangles[1]} ` +
    `(${pct(summary.maxTriangles)} of reference), max draw calls ${summary.maxCalls[1]} (${pct(summary.maxCalls)})`,
);
fs.writeFileSync(
  path.join(candDir, "compare.json"),
  JSON.stringify({ reference: ref.data, candidate: { data: cand.data, build: cand.build }, summary, rows }, null, 1) + "\n",
);
