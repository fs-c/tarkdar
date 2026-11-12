# Measurement harness

Headless Chromium (Playwright) renders a 3D map dataset from a fixed camera set and
records, per view: a screenshot, draw calls, triangles and render time. A
candidate dataset is then compared with the reference, view by view (SSIM,
PSNR, changed pixels). This turns "it looks broken" into numbers and catches
regressions.

```bash
cd tools/maps3d
make install-harness        # once: npm install + Chromium
make reference-data         # once per cache: the full-detail datasets (harness/data/)
make harness-serve          # the harness page on http://localhost:5174 (other terminal)
make reference              # capture the reference of both maps
make measure MAP=customs    # capture maps/3d/customs and compare it
```

or by hand, from `harness/`:

```bash
node capture.mjs --data customs-reference --views views/customs.json --out runs/customs-reference
node capture.mjs --data customs --views views/customs.json --out runs/customs
node compare.mjs runs/customs-reference runs/customs --diff runs/customs/diff
```

For looking rather than measuring, `shot.mjs` takes screenshots through the map's own camera and
settings (styles, projection), as the radar shows it:

```bash
node shot.mjs --data customs --out /tmp/shots --settings '{"style":"plan","orthographic":true}' \
  --views '[{"name":"all"},{"name":"tilted","center":[150,0,0],"span":320,"tilt":45,"heading":20}]'
```

`center` is a game world position, `span` the metres across the height of the view, `tilt` degrees
from vertical.

The page (`page/`) is nothing but the radar's own 3D core (`web/src/map3d`) showing one dataset;
`vite.config.mjs` serves it with the web app's vite and maps `--data <name>` to
`harness/data/<name>` or `maps/3d/<name>`.

## What is what

- **Reference** = `build.py --profile reference`: every renderer at full detail (LOD0 on
  Customs; LOD1 including the indoor scenes on Streets), restricted to the categories structure,
  terrain, water and glass: the quality bar. Captures use the category colours, so geometry is
  compared, not colouring; `--color` switches to material colours.
- **Views** (`views/<map>.json`, committed): `top`, `home`, and for the eight
  busiest scene groups `area:<group>` (45° down) and `low:<group>` (12°,
  close). They are generated once from the reference dataset by
  `make_views.py`, so every candidate is seen from exactly the same cameras.
  The file also fixes field of view, clip planes and fog. Regenerate only when
  the map itself changes (`make views`); old captures are then not comparable.
- **`runs/`** (gitignored): one directory per capture with the PNGs and
  `run.json`; `compare.mjs` adds `compare.json` to the candidate.

## Reading the numbers

- **SSIM** (structural similarity on luma, 8-pixel blocks): 1.0 is identical.
  It drops when structure is missing, displaced or torn; it barely reacts to
  a slightly different shade. Look at `min` as well as `mean`: one broken
  area view matters more than a good average.
- **changed**: share of pixels whose colour differs by more than 8/255.
- **tris / calls**: what was drawn in that view (`renderer.info`), and
  the percentage of the reference.
- **Render time** is only a GPU frame time on a machine with a GPU.
  `run.json` records the WebGL renderer string and `software: true` when
  Chromium fell back to SwiftShader (the development container has no GPU):
  the screenshots and counts are still valid there, the times are not.

`metrics.mjs` has unit tests: `npm test`.
