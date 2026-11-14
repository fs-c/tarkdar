#!/usr/bin/env node
// Frame times on this machine's GPU, through the map's own camera API:
//   node bench.mjs --data customs --settings '{"style":"plan","orthographic":true}' [--no-tiles]
// Each case pans the camera a little per frame (as following a player does) and renders `frames`
// frames back to back, waiting for the GPU (a readPixels) every five: the time per frame is what
// the GPU can do, not what the page asked for. A top-down orthographic view is drawn from tiles
// (web/src/map3d/tiles.ts): "frame" is then a frame from tiles, "paint" what painting the tiles
// of the view took, once. --no-tiles draws every frame directly, as any other view is.
// Prints the WebGL renderer: on SwiftShader (no GPU) the numbers mean nothing.
import { parseArgs } from "node:util";
import { chromium } from "playwright";

const { values: opt } = parseArgs({
  options: {
    url: { type: "string", default: "http://localhost:5174" },
    data: { type: "string", default: "customs" },
    size: { type: "string", default: "1920x1080" },
    dpr: { type: "string", default: "1" },
    settings: { type: "string", default: "{}" },
    frames: { type: "string", default: "100" },
    spans: { type: "string", default: "150,350,1000" },
    headed: { type: "boolean", default: false },
    "no-tiles": { type: "boolean", default: false },
  },
});
const [width, height] = opt.size.split("x").map(Number);
const browser = await chromium.launch({
  headless: !opt.headed,
  channel: "chromium",
  args: ["--ignore-gpu-blocklist", "--enable-gpu", "--use-angle=vulkan", "--enable-features=Vulkan", "--disable-gpu-vsync", "--disable-frame-rate-limit"],
});
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: Number(opt.dpr) });
page.setDefaultTimeout(900_000);
page.on("console", (m) => m.type() === "error" && console.error("page:", m.text()));
page.on("pageerror", (e) => console.error("page:", String(e)));
await page.goto(`${opt.url}/?data=${encodeURIComponent(opt.data)}&color=1&bg=11161c`);
await page.waitForFunction(() => window.__map || window.__mapError);
const failure = await page.evaluate(() => window.__mapError ?? null);
if (failure) throw new Error(failure);

const result = await page.evaluate(async ({ settings, frames, spans, tiles }) => {
  const map = window.__map;
  const { stage } = map.debug();
  const gl = stage.renderer.getContext();
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  const gpu = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : "?";
  const pixel = new Uint8Array(4);
  const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  stage.tileCache = tiles;
  map.setSettings({ ...window.__defaults, trees: true, ...settings });
  const rows = [];
  for (const span of spans) {
    map.resetView();
    map.setViewSpan(span);
    map.renderNow();
    const direct = { calls: map.stats.drawCalls, triangles: map.stats.triangles };
    // Painting the view's tiles, as Map3D does it between frames but in one go.
    let paint = null;
    for (const t0 = performance.now(); performance.now() - t0 < 200; ); // not sleeping: Map3D would paint them
    if (stage.tilesPending) {
      sync();
      const t0 = performance.now();
      let rounds = 0;
      while (stage.tilesPending && rounds++ < 500) {
        stage.paintTiles();
        sync();
      }
      paint = performance.now() - t0;
    }
    await sleep(300);
    const start = map.pose().target;
    const step = span / 2000; // about half a pixel per frame
    // Wait for the GPU every few frames: a long queue of unfinished frames loses the context.
    const run = async (n) => {
      let total = 0;
      for (let done = 0; done < n; done += 5) {
        const t0 = performance.now();
        for (let i = done; i < done + 5; i++) {
          map.centerOn([start[0] + (i % 400) * step, start[1], start[2] + (i % 400) * step * 0.6]);
          map.renderNow();
        }
        sync();
        total += performance.now() - t0;
        await sleep(0);
      }
      if (gl.isContextLost()) throw new Error("WebGL context lost");
      return total / n;
    };
    await run(20); // shaders, buffers
    await sleep(300);
    const ms = Math.min(await run(frames), await run(frames), await run(frames));
    rows.push({ span, ms, paint, fromTiles: map.stats.fromTiles, ...direct });
  }
  return { gpu, rows, buffer: [gl.drawingBufferWidth, gl.drawingBufferHeight] };
}, { settings: JSON.parse(opt.settings), frames: Number(opt.frames), spans: opt.spans.split(",").map(Number), tiles: !opt["no-tiles"] });

console.log(result.gpu);
console.log(`${opt.data}  ${result.buffer.join("x")}  ${opt.settings}`);
for (const r of result.rows) {
  console.log(
    `  span ${String(r.span).padStart(5)} m  ${r.ms.toFixed(2).padStart(7)} ms/frame ${r.fromTiles ? "from tiles" : "direct    "}` +
      `  ${r.paint === null ? "" : `paint ${r.paint.toFixed(0).padStart(4)} ms  `}` +
      `(the map: ${r.calls} calls, ${(r.triangles / 1e6).toFixed(2)}M triangles)`,
  );
}
await browser.close();
