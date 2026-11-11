# Measurement harness

Headless Chromium (Playwright) drives the viewer from a fixed camera set and
records, per view: a screenshot, draw calls, triangles and render time. A
candidate dataset is then compared with the reference, view by view (SSIM,
PSNR, changed pixels). This turns "it looks broken" into numbers and catches
regressions.

```bash
make install-harness                     # once: npm install + Chromium
make dev                                 # viewer on http://localhost:5174 (other terminal)
make reference                           # capture the reference of both maps
make measure DATASET=customs             # capture a candidate and compare it
```

or by hand, from `harness/`:

```bash
node capture.mjs --views views/customs.json --out runs/customs-reference \
     --query "?mode=explore&cats=structure,terrain,water,glass&color=0"
node capture.mjs --views views/customs.json --out runs/customs --query "?cats=structure,terrain,water,glass&color=0"
node compare.mjs runs/customs-reference runs/customs --diff runs/customs/diff
```

## What is what

- **Reference** = the explore dataset (full LOD geometry, nothing dropped)
  restricted to the categories structure + terrain + water + glass: the
  quality bar. `?cats=` is the viewer's category filter; `color=0` selects the
  category colours so that geometry is compared, not colouring.
- **Views** (`views/<map>.json`, committed): `top`, `home`, and for the eight
  busiest scene groups `area:<group>` (45° down) and `low:<group>` (12°,
  close). They are generated once from the explore dataset by
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
- **tris / calls**: what the viewer drew in that view (`renderer.info`), and
  the percentage of the reference.
- **Render time** is only a GPU frame time on a machine with a GPU.
  `run.json` records the WebGL renderer string and `software: true` when
  Chromium fell back to SwiftShader (the development container has no GPU):
  the screenshots and counts are still valid there, the times are not.

`--uniform` draws everything with one grey material: use it to compare
geometry alone when two builds classify or colour things differently.

`metrics.mjs` has unit tests: `npm test`.
