#!/usr/bin/env node
// Capture a dataset from the fixed camera set of its map.
//
//   node capture.mjs --query "?mode=explore&cats=structure,terrain,water,glass" \
//        --views views/customs.json --out runs/customs-reference
//
// Needs the viewer dev server (make dev). Writes <out>/<view>.png and
// <out>/run.json (draw calls, triangles and render time per view).
// Options: --url http://localhost:5174  --size 1280x800  --only top,area:*
//          --uniform (one grey material for everything: isolates geometry)

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright";

const { values: opt } = parseArgs({
  options: {
    url: { type: "string", default: "http://localhost:5174" },
    query: { type: "string", default: "" },
    views: { type: "string" },
    out: { type: "string" },
    size: { type: "string", default: "1280x800" },
    only: { type: "string" },
    uniform: { type: "boolean", default: false },
  },
});
if (!opt.views || !opt.out) {
  console.error("usage: node capture.mjs --views views/<map>.json --out <dir> [--query ...] (see the file header)");
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
// ?paused: the viewer does not start its render loop; frames are rendered below.
await page.goto(`${opt.url}/${opt.query}${opt.query.includes("?") ? "&" : "?"}paused`);
await page.waitForFunction(
  () => window.__map || document.getElementById("loader-text")?.textContent?.startsWith("Failed"),
);
const failure = await page.evaluate(() => (window.__map ? null : document.getElementById("loader-sub")?.textContent));
if (failure) {
  console.error(`viewer failed to load: ${failure}`);
  await browser.close();
  process.exit(1);
}
const loadMs = Date.now() - t0;

// Fixed camera parameters, no grid, no damping.
const setup = await page.evaluate(
  ({ viewSet, uniform }) => {
    const { THREE, stage, index, visible } = window.__map;
    stage.controls.enableDamping = false;
    if (stage.grid) stage.grid.visible = false;
    stage.camera.fov = viewSet.fov;
    [stage.camera.near, stage.camera.far] = viewSet.clip;
    stage.camera.updateProjectionMatrix();
    [stage.scene.fog.near, stage.scene.fog.far] = viewSet.fog;
    if (uniform) {
      const material = new THREE.MeshStandardMaterial({ color: 0xb9c1c8, roughness: 0.93, metalness: 0 });
      stage.scene.traverse((o) => {
        if (o.isInstancedMesh) {
          o.material = material;
          o.instanceColor = null;
        }
      });
    }
    const gl = stage.renderer.getContext();
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    return {
      dataset: index.map,
      profile: index.profile,
      stats: index.stats,
      visible: visible(),
      gpu: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "unknown",
    };
  },
  { viewSet, uniform: opt.uniform },
);
const software = /swiftshader|llvmpipe|software/i.test(setup.gpu);

const results = [];
for (const view of views) {
  const shot = await page.evaluate(({ view, repeats }) => {
    const { stage } = window.__map;
    stage.camera.position.set(...view.position);
    stage.controls.target.set(...view.target);
    stage.controls.update();
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
  }, { view, repeats: software ? 1 : 3 });   // software frames take seconds: render once
  const file = `${view.name.replace(/[^A-Za-z0-9_-]+/g, "_")}.png`;
  fs.writeFileSync(path.join(opt.out, file), Buffer.from(shot.png.split(",")[1], "base64"));
  results.push({ name: view.name, file, calls: shot.calls, triangles: shot.triangles, renderMs: Math.round(shot.renderMs * 10) / 10 });
  console.log(`${view.name.padEnd(34)} ${String(shot.calls).padStart(6)} calls ${String(shot.triangles).padStart(11)} tris ${shot.renderMs.toFixed(0).padStart(7)} ms`);
}
await browser.close();

const run = {
  query: opt.query,
  views: path.basename(opt.views),
  size: [width, height],
  uniform: opt.uniform,
  ...setup,
  software,
  loadMs,
  results,
  errors,
};
fs.writeFileSync(path.join(opt.out, "run.json"), JSON.stringify(run, null, 1) + "\n");
console.log(`${setup.dataset}: ${results.length} views -> ${opt.out}  (${setup.gpu}${software ? "; software rendering: render times are not GPU frame times" : ""})`);
if (errors.length) console.log(`page errors: ${errors.slice(0, 3).join(" | ")}`);
