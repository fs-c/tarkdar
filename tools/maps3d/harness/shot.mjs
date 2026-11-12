#!/usr/bin/env node
// Screenshots of a dataset through the map's own camera API (not the fixed harness views):
//   node shot.mjs --data customs --out /tmp/shots/a --settings '{"orthographic":true}' \
//        --bg 11161c --views '[{"name":"all"},{"name":"dorms","center":[200,0,150],"span":250,"tilt":0,"heading":0}]'
// center: game world [x, y, z]; span: metres across the view height; tilt: degrees from vertical.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright";

const { values: opt } = parseArgs({
  options: {
    url: { type: "string", default: "http://localhost:5174" },
    data: { type: "string", default: "customs" },
    out: { type: "string" },
    size: { type: "string", default: "1600x1000" },
    settings: { type: "string", default: "{}" },
    views: { type: "string", default: '[{"name":"all"}]' },
    bg: { type: "string", default: "9aacbd" },
  },
});
const [width, height] = opt.size.split("x").map(Number);
fs.mkdirSync(opt.out, { recursive: true });
const browser = await chromium.launch({ args: ["--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
page.setDefaultTimeout(900_000);
page.on("console", (m) => m.type() === "error" && console.error("page:", m.text()));
page.on("pageerror", (e) => console.error("page:", String(e)));
await page.goto(`${opt.url}/?data=${encodeURIComponent(opt.data)}&color=1&bg=${opt.bg}`);
await page.waitForFunction(() => window.__map || window.__mapError);
const failure = await page.evaluate(() => window.__mapError ?? null);
if (failure) throw new Error(failure);
for (const view of JSON.parse(opt.views)) {
  const png = await page.evaluate(async ({ view, settings }) => {
    const map = window.__map;
    const chosen = { ...window.__defaults, trees: true, ...settings, ...(view.settings ?? {}) };
    // A palette may be given by the name of a pre-made one.
    if (typeof chosen.palette === "string") chosen.palette = window.__palettes[chosen.palette];
    map.setSettings(chosen);
    map.resetView();
    if (view.center) {
      const tilt = ((view.tilt ?? 0) * Math.PI) / 180, heading = ((view.heading ?? 0) * Math.PI) / 180;
      const d = 1000, [x, y, z] = view.center;
      const h = Math.max(Math.sin(tilt), 1e-4) * d;
      map.setPose([x - Math.sin(heading) * h, y + Math.cos(tilt) * d, z - Math.cos(heading) * h], view.center);
    }
    if (view.span) map.setViewSpan(view.span);
    await new Promise((r) => setTimeout(r, view.wait ?? 300));
    map.renderNow();
    return map.debug().stage.renderer.domElement.toDataURL("image/png");
  }, { view, settings: JSON.parse(opt.settings) });
  fs.writeFileSync(path.join(opt.out, `${view.name}.png`), Buffer.from(png.split(",")[1], "base64"));
  console.log(view.name);
}
await browser.close();
