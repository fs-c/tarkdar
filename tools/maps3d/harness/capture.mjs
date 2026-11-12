#!/usr/bin/env node
// Capture a dataset from the fixed camera set of its map.
//
//   node capture.mjs --data customs-reference --views views/customs.json --out runs/customs-reference
//   node capture.mjs --data customs --views views/customs.json --out runs/customs
//
// Needs the harness page (make harness-serve). Writes <out>/<view>.png and <out>/run.json
// (draw calls, triangles and render time per view).
// Options: --url http://localhost:5174  --size 1280x800  --only top,area:*  --color (material colours)

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright";

const { values: opt } = parseArgs({
  options: {
    url: { type: "string", default: "http://localhost:5174" },
    data: { type: "string" },
    color: { type: "boolean", default: false },
    views: { type: "string" },
    out: { type: "string" },
    size: { type: "string", default: "1280x800" },
    only: { type: "string" },
  },
});
if (!opt.views || !opt.out || !opt.data) {
  console.error("usage: node capture.mjs --data <dataset> --views views/<map>.json --out <dir> (see the file header)");
  process.exit(2);
}

const viewSet = JSON.parse(fs.readFileSync(opt.views, "utf8"));
const patterns = opt.only?.split(",").map((p) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`));
const views = viewSet.views.filter((v) => !patterns || patterns.some((p) => p.test(v.name)));
const [width, height] = opt.size.split("x").map(Number);
fs.mkdirSync(opt.out, { recursive: true });

const browser = await chromium.launch({
  // Use the GPU when there is one; fall back to software (SwiftShader) rendering.
  args: ["--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
page.setDefaultTimeout(900_000);
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));

const t0 = Date.now();
await page.goto(`${opt.url}/?data=${encodeURIComponent(opt.data)}&color=${opt.color ? 1 : 0}`);
await page.waitForFunction(() => window.__map || window.__mapError);
const failure = await page.evaluate(() => window.__mapError ?? null);
if (failure) {
  console.error(`the dataset failed to load: ${failure}`);
  await browser.close();
  process.exit(1);
}
const loadMs = Date.now() - t0;

const setup = await page.evaluate(() => {
  const { stage, data } = window.__map.debug();
  const gl = stage.renderer.getContext();
  const dbg = gl.getExtension("WEBGL_debug_renderer_info");
  return {
    dataset: data.index.map,
    profile: data.index.profile,
    build: data.index.build ?? null,
    stats: data.index.stats,
    gpu: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "unknown",
  };
});
const software = /swiftshader|llvmpipe|software/i.test(setup.gpu);

const results = [];
for (const view of views) {
  const shot = await page.evaluate(({ view, repeats, viewSet }) => {
    const { stage } = window.__map.debug();
    // Per view, not once: a frame the page renders on its own resets the clip planes.
    stage.camera.fov = viewSet.fov;
    [stage.camera.near, stage.camera.far] = viewSet.clip;
    stage.camera.updateProjectionMatrix();
    // Straight onto the camera: the views are in the renderer's own space, and the map's
    // controls would clamp tilt and distance.
    stage.camera.position.set(...view.position);
    stage.camera.lookAt(...view.target);
    const gl = stage.renderer.getContext();
    const times = [];
    const pixel = new Uint8Array(4);
    for (let i = 0; i < repeats; i++) {
      const t = performance.now();
      stage.renderer.render(stage.scene, stage.camera);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);   // blocks until the frame is drawn
      times.push(performance.now() - t);
    }
    const info = stage.renderer.info.render;
    return {
      png: stage.renderer.domElement.toDataURL("image/png"),
      calls: info.calls,
      triangles: info.triangles,
      renderMs: times.sort((a, b) => a - b)[times.length >> 1],
    };
  }, { view, repeats: software ? 1 : 3, viewSet: { fov: viewSet.fov, clip: viewSet.clip } });   // software frames take seconds: render once
  const file = `${view.name.replace(/[^A-Za-z0-9_-]+/g, "_")}.png`;
  fs.writeFileSync(path.join(opt.out, file), Buffer.from(shot.png.split(",")[1], "base64"));
  results.push({ name: view.name, file, calls: shot.calls, triangles: shot.triangles, renderMs: Math.round(shot.renderMs * 10) / 10 });
  console.log(`${view.name.padEnd(34)} ${String(shot.calls).padStart(6)} calls ${String(shot.triangles).padStart(11)} tris ${shot.renderMs.toFixed(0).padStart(7)} ms`);
}
await browser.close();

const run = {
  data: opt.data,
  color: opt.color,
  views: path.basename(opt.views),
  size: [width, height],
  ...setup,
  software,
  loadMs,
  results,
  errors,
};
fs.writeFileSync(path.join(opt.out, "run.json"), JSON.stringify(run, null, 1) + "\n");
console.log(`${setup.dataset}: ${results.length} views -> ${opt.out}  (${setup.gpu}${software ? "; software rendering: render times are not GPU frame times" : ""})`);
if (errors.length) console.log(`page errors: ${errors.slice(0, 3).join(" | ")}`);
