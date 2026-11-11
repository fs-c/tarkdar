# Hand-off — EFT 3D map spike

Last updated: 2026-11-11 (overview accepted by the user; colour, relief, tree markers, coordinate pick added)

## TL;DR

`maps-experimental-3d` extracts real Unity geometry from **Escape from Tarkov**
for **Customs / bigmap** and **Streets / TarkovStreets** and renders it in a
small three.js viewer. It is meant to replace the hand-calibrated 2D maps.

Where it stands:

- **Overview** (the default view) is now built from **merged 128 m cells**:
  LOD1 geometry merged per cell, simplified to a 10 cm error bound, hidden
  surfaces removed, flat shaded, with baked per-vertex material colours.
  Customs: 5.3M triangles, 114 draw calls. Streets (exteriors): 7.9M, 108.
- **Quality is measured**, not eyeballed: `harness/` compares each dataset
  with the reference (explore restricted to structure + terrain + water +
  glass) from 18 fixed cameras per map. Mean SSIM: Customs 0.909, Streets
  0.940 (the old decimated overview: 0.834 / 0.733).
- Pipeline: `extract_cache.py` (needs the game, done) → `cache/` (in B2) →
  `build.py` (no game) → dataset format 2 → TypeScript viewer. **All further
  work builds from `cache/` only**; see "Working without the game".
- **Not done yet**: download size (137 / 208 MB per map, uncompressed),
  runtime LOD levels, picking inside merged cells, foliage, interiors. See
  "Roadmap".
- **The user has reviewed the overview** (see "Decisions"): geometry and level
  of detail are right, performance is fine, no further optimization unless it
  is an easy win. The second round added lighter colours (on by default),
  terrain relief, tree markers and the coordinate pick; the user has not seen
  those yet.

## Working without the game

The development machine has no game mount. Everything needed is in `cache/`,
which lives in Backblaze B2 (repo-root `assets.json`, `scripts/assets.py`;
credentials: root README, "Data files").

```bash
cd maps-experimental-3d
make cache-pull        # ~0.73 GB from B2
make install           # .venv (numpy, fast-simplification; UnityPy only for stage 1)
make datasets          # the five viewer datasets, ~4 min (6 cores)
make test              # extract unit tests + validation checks, viewer typecheck + vitest
make dev               # viewer, http://localhost:5174/
```

The cache was extracted on 2026-11-11 from Unity **2022.3.43f2** with
`EXTRACTOR_VERSION = 3` (`cache/manifest.json` records per-scene source file
sizes/mtimes). It holds deliberately more than today's build uses, so that the
phases below don't need the game; see "What the cache holds, per phase".
Re-extraction (new game patch, more maps, missing data) needs a machine with
`EscapeFromTarkov_Data`; afterwards `make cache-push` and commit `assets.json`.

## Locations and repository

- Project: `maps-experimental-3d/` in the `tarkdar` repo.
- Game data (only to re-extract, on a machine that has the game):
  `EscapeFromTarkov_Data` of the installation.
- Viewer: http://localhost:5174/ (fixed in `viewer/vite.config.ts`; 5173 is
  used by `web/`).
- Generated datasets live in `viewer/public/data/<name>/` and are
  **gitignored** (~0.8 GB).
- The current development machine is an arm64 container **without a GPU**:
  headless Chromium renders with SwiftShader, so screenshots and
  `renderer.info` counts are valid, frame times are not.

## Layout

```
cache/                 extraction cache (B2 via ../assets.json, gitignored)
extract/
  extract_cache.py     stage 1: game files -> cache/ (needs UnityPy + game)
  build.py             stage 2: cache/ -> viewer dataset (no game needed)
  compare_datasets.py  exact comparison of two datasets (parity checks)
  t3d/pack.py          deterministic container format (zstd for the cache)
  t3d/cache.py         manifest, scene files, mesh store, texture store
  t3d/unity.py         UnityPy scene walker (meshes, materials, textures, terrain)
  t3d/geometry.py      coordinate conversion, normals, parts, terrain mesh, decimation
  t3d/classify.py      THE classifier: shader rules + name-token rules -> category, flags
  t3d/dataset.py       dataset format 2 writer/reader
  t3d/hlod.py          overview: merge into cells, simplify, weld, colours
  t3d/visibility.py    bake-time hidden-surface removal (sampled depth buffers)
  t3d/maps.py          map presets (scene paths)
  tests/               unittest: pack/cache, geometry, classifier, build, cells, visibility,
                       validation checks
  requirements.txt     numpy, meshoptimizer, fast-simplification (+ UnityPy for stage 1)
harness/               headless measurement harness (Playwright); README there
  capture.mjs          screenshots + renderer counts from fixed cameras
  compare.mjs          SSIM / PSNR / triangles / draw calls vs the reference
  views/<map>.json     the fixed cameras (committed)
viewer/                TypeScript + three.js + vite (vitest for unit tests)
  index.html
  src/main.ts          boot, top bar, wiring
  src/url.ts           ?mode / ?map -> dataset
  src/container.ts     pack container decoder
  src/dataset.ts       format 2 loader, MapData (instances, slots, boxes)
  src/filter.ts        visible-slot filter, counts, filter report
  src/instances.ts     slots -> InstancedMeshes (merged index ranges)
  src/scene.ts         renderer, camera, lights, per-category materials, terrain relief
  src/color.ts         colour lift, sRGB -> linear
  src/explore.ts       strip-down panel
  src/picker.ts        click-to-identify, selection report
  src/*.test.ts        vitest
  public/data/         generated datasets (gitignored)
Makefile
README.md              fuller reference (cache contents, dataset format, flags)
```

## Viewer modes

| Mode | URL | Dataset |
|---|---|---|
| Customs overview | `/` | `customs` |
| Streets overview | `/?map=streets` | `streets` |
| Customs explore | `/?mode=explore` | `customs-explore` |
| Streets explore | `/?mode=explore&map=streets` | `streets-explore` |
| Customs inspect/picker | `/?mode=inspect` | `customs-inspect` |
| old decimated overview | `/?map=customs-legacy`, `/?map=streets-legacy` | after `make legacy` |

Any dataset directory name works as `?map=`. `?cats=structure,terrain` starts
with only those categories; `?paused` does not start the render loop (harness).

- **Colour** / `C` (on by default; `?color=0` starts without): material
  colours instead of category colours. On the overview they are baked per
  vertex (albedo-thumbnail mean × `_Color`). The viewer lifts them
  (`viewer/src/color.ts`: luma → 0.36 + 0.58 × luma, hue kept): the raw means
  have a median luma of 0.3 and the user found them too dark and uneven.
- **Terrain ground colour** (colour mode): the build blends the 12 terrain
  layers' mean colours by the splat maps into one image per terrain slice
  (`geometry.terrain_colors`, 1024², 0.68 m/pixel, ~0.75 MB PNG each) and the
  viewer drapes it over the terrain, lifted and muted by 40 % (the lifted
  grass mean is lime green). Backdrop terrain meshes around the map have no
  such data and take the average ground colour. Streets has no Unity terrain.
- **Terrain relief** (`scene.ts` `addRelief`): slope shading, a low-to-high
  tint and 2 m contour lines (every fifth stronger). Lines are suppressed on
  nearly level ground and when they would be closer than a few pixels.
- **Trees** on the overview are translucent markers (cone + trunk, one per
  tree ≥ 3 m), toggled by Vegetation / `V`, ignored by the pick tool.
- **Pick** / `P` (on by default in every mode): click a point, Shift-click to
  add more. Each entry shows the **game world coordinates** of the clicked
  point; Copy report adds the object under it and the camera pose. This is
  the intended way for the user to say where something is wrong. A pose from a
  report reproduces the view: `?cam=x,y,z,tx,ty,tz` (the report's
  `camera.position` + `camera.target`). In explore/inspect the report also
  has mesh, material/shader, scene and hierarchy path; on the overview the
  object is only the cell mesh.
- Explore has the strip-down panel (categories, world size, scenes, mesh
  name, Copy filter) and starts with everything visible; inspect hides the
  shadow/decal/background categories by default.
- On the overview **glass is solid** (there are no interiors behind it), and
  the near plane follows the zoom to keep depth precision (z-fighting).

## Datasets (current build.py output)

| Dataset | Geometry | Instances | Meshes | Triangles | Chunk |
|---|---|---:|---:|---:|---:|
| `customs` | overview: cells, 10 cm, hidden surfaces removed | 168 | 120 | 5.3M | 136.8 MB |
| `streets` | overview, exterior scenes only | 270 | 111 | 7.9M | 207.7 MB |
| `customs-inspect` | LOD0 | 94,194 | 4,176 | 74.7M | 169.7 MB |
| `customs-explore` | LOD0, nothing dropped | 141,088 | 7,930 | 92.0M | 214.8 MB |
| `streets-explore` | LOD1, nothing dropped, all City scenes | 164,702 | 17,106 | 98.1M | 278.5 MB |
| `customs-legacy` | LOD1 + dec 0.8 (`make legacy`) | 50,473 | 3,192 | 9.0M | 27.5 MB |
| `streets-legacy` | LOD1 + dec 0.8, exterior | 38,925 | 5,434 | 9.1M | 37.7 MB |

Built on the arm64 container. The legacy (decimated) datasets differ by a few
hundred instances between platforms (`fast-simplification` is not
bit-reproducible); the others are deterministic.

Triangles per category in the explore datasets (`index.json` → `stats`):

| | structure | terrain | water | foliage | glass | shadow | decal | background |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Customs | 61.0M | 1.1M | 282 | 11.7M | 0.09M | 16.7M | 1.4M | 0.1M |
| Streets | 70.4M | 3,721 | 1,276 | 4.4M | 0.20M | 22.0M | 1.0M | 0.2M |

Measured against the reference (`make measure DATASET=…`, 18 views each):

| Dataset | mean SSIM | min SSIM | triangles, whole map | zoomed views | draw calls |
|---|---:|---:|---:|---:|---:|
| `customs` | 0.909 | 0.866 | 5.3M | 0.8–4.6M | 114 |
| `customs-legacy` | 0.834 | 0.744 | 7.5M | 4.6–7.3M | 2,656 |
| `streets` | 0.940 | 0.904 | 7.9M | 2.7–7.8M | 108 |
| `streets-legacy` | 0.733 | 0.626 | 8.1M | 6.4–7.8M | 5,314 |

The overview rows were re-measured after glass became solid there (the
reference keeps translucent glass); before that they were 0.924 / 0.874 and
0.944 / 0.910, which is what the Phase 2 table below uses. The legacy rows
are from before. Captures use `color=0` (category colours).

Frame rates have not been measured: the container has no GPU. The original
spike on an integrated AMD GPU at 1500×950 ran the legacy overview at 45–60
fps and explore at 12–24 fps.

## Pipeline

1. `extract_cache.py --map customs --map streets` (`make cache`). Reads the
   game, records everything unfiltered. Incremental per scene, deterministic
   output (identical bytes on re-run). ~7–13 min for both maps (texture decoding).
2. `build.py --map … --profile overview|inspect|explore|legacy`
   (`make datasets`). All filtering, LOD choice, simplification and coordinate
   conversion happen here. The overview profile then runs `t3d/hlod.py`:
   1. instances → 128 m grid cells by bounding-box centre, per category
      (structure, glass); shadow/decal/background/foliage are dropped,
      terrain and water stay as instances;
   2. each cell is merged in world space and simplified with meshoptimizer to
      an **absolute error** (`--error`, default 0.10 m) with pruning: props
      smaller than the error disappear, there is no size cutoff;
   3. hidden-surface removal (`t3d/visibility.py`): triangles that no
      front-facing sample shows from any of 45 directions are dropped. Terrain
      hides what is buried; other cells are not considered, so it errs on
      keeping;
   4. vertices are welded by position + colour (cells are flat shaded);
   5. every foliage renderer ≥ 3 m tall (and < 40 m wide) becomes one
      instance of a shared `tree_marker` mesh, merged per 2 m square.
   Cells run in parallel worker processes (one BLAS thread each).

Presets: Customs = 23 scene paths in `t3d/maps.py`. Streets = the 223 City
scenes from BuildSettings; the build drops `*indoor*` (leaving 161) unless
`--include-indoor`. Customs `*_indoor` scenes are always kept
(`indoorOptional: false`; they hold the dorm interiors/walls).

Parity: all six datasets built from the cache were byte-identical to the
legacy single-stage extractor (removed; `git log` has it) — both with the v1
cache and after the v2 re-extract. Before the LOD membership fix (invariant
3) the format 2 datasets were checked against those: per instance the geometry bytes and scene are identical, matrices
differ by ≤ 0.14 mm (float32 instead of 6-decimal JSON).

## What the cache holds, per phase

Everything is in **Unity space** (left-handed, raw vertex data, original
winding, Unity world matrices row-major). Full field list: README "Cache
contents". Unity world coordinates are the game's world coordinates, i.e. the
same space the radar backend reports player positions in: **no 2D-style
calibration is needed** to place players in the 3D map.

| Need | Where in the cache |
|---|---|
| Artist LODs for simplification | every LOD level's mesh; `lodGroups` (screen-relative heights, size), `lod_members` |
| Error-bounded simplification, HSR | raw positions/normals/indices per mesh (`meshes/`); collider meshes (often already simplified hulls of buildings) |
| Classification without name heuristics | `meta.materials[*].shader` (e.g. `Decal/…`, `p0/Cutout/…`, `…Transparent…`, water shaders), `renderQueue`, keywords |
| Colour for untextured/HLOD geometry | albedo thumbnails + `mean` per texture, material `_Color` etc., vertex colours (`Custom/Vert Paint …` shaders use them) |
| Baked low-res texture atlases | UV0–UV7 per mesh, texture slot scale/offset, ≤128 px albedo thumbnails |
| Terrain appearance | splat/alpha maps (≤1024 px) + terrain layers (diffuse thumbnail, tile size) |
| Trees as geometry | terrain tree instances + prototypes resolved to prefab meshes/materials/LOD level |
| Spatial partitioning / culling | world matrices + meshes → AABBs; colliders; scene/hierarchy paths (`goPath`) for grouping buildings |
| Interiors toggle | scene names (`*_indoor`), hierarchy paths, trigger colliders |

Not cached (needs the game again): full-resolution textures, normal/specular
pixels (only names/sizes), tangents, skinned meshes, lights, MonoBehaviours,
Unity occlusion (Umbra) data, maps other than Customs/Streets. Lightmaps: EFT
scenes report none (`stats.lightmaps == 0`), so there is no baked lighting to
reuse. Static batching: not used (every `r_static_batch` is `[0, 0]`). Meshes
named `*combined*` are artist-made, not Unity batch meshes, and need no
special handling.

## Important fixes / invariants

These are easy to regress:

1. **Do not skip `_LOD1`/`_LOD2`/`_LOD3` meshes by name.** LOD groups are
   filtered by the LOD selector; name-skipping deleted selected meshes.
2. **PPtr keys must resolve the target file.** Path IDs are only unique within
   a file. Current key: `(resolved target file name, path_id)` via
   `file_id → externals`. Keying by the referencing file produced giant phantom
   objects.
3. **A renderer can belong to several LOD levels and groups** (one mesh
   reused for LOD0 and LOD1 is listed in both levels). The cache stores the raw
   memberships; the build keeps a renderer when **any** membership is the
   level chosen for that group. The legacy "last membership wins" rule dropped
   such renderers at one of their levels: e.g. the chemical factory lost its
   brick walls at LOD0 and its roof at LOD1 (~1,150 structure instances on
   Customs, ~1,500 on Streets). This deliberately ends byte parity with the
   legacy extractor.
4. **Coordinate conversion**: positions `(x, y, -z)`, matrices
   `S · M_unity · S` with `S = diag(1,1,-1,1)`. Imported triangle winding is
   reversed; generated terrain is authored directly in three.js space.
5. **Terrain heights**: `local_y = raw / 32768 * heightmap_scale.y`, calibrated
   against tree placements (~1 cm median error).
6. **Pruning is off by default.** It removed unique walls/roofs.
7. **Category matching is token-based**, not substring-based (`plant` in
   `Treatment_Plant` is not foliage, `tree` in `Street` is not foliage).
8. **Texture thumbnails are top row first** (PIL order), not Unity's
   bottom-up order. Flip V when sampling with Unity UVs.
9. **Category is per material slot, not per mesh.** ~5 % of renderers mix
   categories across submeshes (decal or glass submeshes inside an opaque
   mesh). Submesh k uses material k; Unity repeats the last material.
10. **Shader rules come before name rules** in `classify.py`. Name-only
    classification mislabelled ~2,600 shadow proxies, ~3,600 decals and
    ~4,500 foliage renderers as structure.
11. **Category ids are positions in `classify.CATEGORIES`** and are written
    into datasets: append new categories, never reorder.
12. **Visibility samples must be denser than the pixel grid** (0.7 × pixel)
    and cell-centred in the triangle. Sparser or edge-aligned samples leave
    holes in the depth buffer and hidden geometry survives (never the reverse).
13. **Limit BLAS threads in the cell workers** (`hlod.bake` sets
    `OPENBLAS_NUM_THREADS=1`). Without it six workers start six threads each
    and the bake takes over ten minutes instead of about one.

## Known issues / limitations

- **Download size**: the overview chunks are 137 MB (Customs) and 208 MB
  (Streets), raw float32/uint32. Quantization + meshopt codecs are the next
  step (see Roadmap).
- **One level of detail.** 10 cm error everywhere: curved objects (tanks,
  barrels, cars) are visibly faceted close up, thin things (wires, ladders,
  street-lamp heads) are gone. Accepted for an early version by the user.
- **Trees are markers only**; bushes and grass are not shown.
- **Picking on the overview returns coordinates and the cell**, not the object.
- **Reported by the user, not yet located**: some z-fighting on Streets and
  windows one could look through. The near-plane change and solid glass are
  aimed at both, unverified; ask for pick reports if they persist.
  Remaining z-fighting would be coplanar surfaces inside a cell (the
  visibility bias keeps surfaces within 20 cm of each other).
- **Streets overview has exteriors only**; Customs includes its `*_indoor`
  scenes, of which hidden-surface removal keeps what is visible from outside.
- **Glass is translucent in explore/inspect**, solid on the overview.
- **Colours are flat means**, lifted in the viewer; cutout textures give dark
  means (transparent texels count). The edge between real terrain (ground
  image) and backdrop terrain (one colour) is visible.
- **Terrain seam** between the two central Customs heightmap slices.
- **Orientation** is Unity world space; not aligned to the in-game pocket map.
- **Inspect dataset is Customs-only.**
- **Other maps** need a preset/scene list and a re-extract with the game.

## Decisions (user, 2026-11-11)

Before Phase 2:

1. **Interiors**: not needed initially. The ideal version has simplified
   interiors: at least floors, walls and windows.
2. **Budget**: ≤ 5–10M visible triangles, ≤ 500 draw calls, ≤ 150 MB per map
   and 60 fps on the integrated AMD GPU are working numbers only. The real
   goal is: optimize as far as possible while keeping the desired visual
   fidelity.
3. **Viewer in TypeScript**: yes (done).
4. **Camera**: it must be possible to zoom in quite far, but an early version
   need not have fine LODs; looking a bit chunky when zoomed in is fine.

After looking at the merged-cell overview:

5. **Geometry is "basically perfect"**; faceted curves and missing wires etc.
   are fine. **10 cm** stays the error bound.
6. **Colour on by default**, but lighter on average and more consistent; and
   terrain elevation must be easier to read. (Both addressed; not yet seen.)
7. **Trees: yes, as visual references only** ("there's a tree there"), little
   detail, and they should not get in the way.
8. **No more time on optimization** unless there are easy wins: the current
   state is liked, also performance-wise. Compression and LOD levels are
   therefore parked, not planned.
9. A way to point at a place was wanted ("coordinate pick tool"): done.

## Roadmap

Constraint throughout: offline compute is cheap, the viewer must be light.

### Phase 0 — what changed (done)

- **One classifier** (`t3d/classify.py`), extended with shader rules, run in
  `build.py`; the result is written per material slot. The JS classifier is
  gone.
- **Dataset format 2**: `index.json` + self-describing binary chunks
  (`kind`, `level`, `error`, `cell`) + lazy `sources.json`. A custom container
  (the existing `pack.py` layout, uncompressed) rather than glTF/gltfpack: the
  build needs cells, LOD levels and a source table anyway, and the decoder is
  ~60 lines. Per-array meshopt compression can be added behind the chunk
  header later. Details: README "Output format".
- **Viewer in TypeScript**, split into modules; one render path (instanced
  index ranges) for all modes; batched/hybrid/baked paths removed.
- **Tests**: `make test` (74 Python tests incl. the validation checks over the
  real cache when present, 27 vitest tests, harness metric tests).
- Verified before the LOD fix: dataset parity (above), and old vs new viewer
  screenshots with a uniform material differ in ≤ 0.011 % of pixels (Customs
  overview/inspect, Streets overview); Customs explore has identical triangle
  counts and differs only where shadow proxies z-fight (0.6 % in one view).
- Deliberate visual changes: glass is translucent; inspect no longer shows
  shader-classified shadow proxies and decals as grey structure.

### Phase 1 — reference + measurement harness (done)

`harness/` (README there): headless Chromium via Playwright.

- **Reference** = the explore dataset restricted to structure + terrain +
  water + glass (`?mode=explore&cats=structure,terrain,water,glass`): no
  separate dataset, the viewer's `?cats=` filter does it. Glass is included
  because windows used to be part of "structure".
- **Fixed cameras** per map in `harness/views/<map>.json` (committed): `top`,
  `home`, and `area:<group>` (45°) + `low:<group>` (12°, close) for the eight
  busiest scene groups. Generated once from the explore dataset
  (`make views`), so candidates cannot move the cameras.
- `make reference` captures the reference of both maps, `make measure
  DATASET=<name>` captures a candidate and prints SSIM / PSNR / changed
  pixels per view plus triangles and draw calls relative to the reference
  (`harness/runs/<name>/compare.json`, heat maps in `…/diff/`).
- The viewer's `?paused` flag keeps it from starting its render loop; the
  harness renders single frames. (Without it, software-rendered frames of the
  90M-triangle datasets queue up for minutes.)
- **No hardware WebGL on the development container** (no `/dev/dri`):
  Chromium uses SwiftShader. Screenshots, triangles and draw calls are valid;
  render times are not frame times. `run.json` records the renderer string
  and `software: true`. Real fps must be measured on a machine with a GPU
  (`make install-harness && make reference && make measure` works there
  unchanged and then reports meaningful render times).

Phase 1 also found the LOD membership bug (invariant 3): the reference itself
was missing walls. The reference in `harness/runs/` must be re-captured
whenever the explore datasets change (`make reference`, ~15 min in software).

### Phase 2 — offline simplification (first cut done)

Done (see "Pipeline" for how): cells + merge, error-bounded simplification
with pruning (replaces both the flat decimation and the 1 m prop cutoff),
bake-time hidden-surface removal, flat shading, baked vertex colours.

What the measurements said (Customs, mean SSIM / whole-map triangles):

| variant | SSIM | triangles |
|---|---:|---:|
| legacy overview | 0.834 | 7.5M |
| cells, 2 cm / 5 cm / 10 cm / 25 cm / 50 cm (smooth normals, no HSR) | 0.951 / 0.930 / 0.914 / 0.889 / 0.866 | 20.6M / 11.8M / 9.0M / 6.6M / 4.9M |
| 10 cm starting from LOD0 instead of LOD1 | 0.911 | 11.8M |
| 10 cm + hidden-surface removal | 0.913 | 6.2M |
| … + flat shading (and welding by position) | 0.924 | 6.2M |
| … + buried geometry removed (current) | 0.924 | 5.3M |

So: LOD1 is the right base; hidden-surface removal is free in quality; flat
shading is better than carrying the original normals through simplification
(they produced dark patches) and nearly halves the vertex count.

Parked (decision 8), in the order they would pay off if picked up again:

1. **Compression**: per-cell int16 positions, meshopt vertex/index codecs
   (the Python bindings have `encode_vertex_buffer` / `encode_index_buffer`;
   the `meshoptimizer` npm package decodes), behind the chunk header. Expected
   to bring a map from 137 / 208 MB to roughly 30–50 MB. This is the one
   working number still missed (≤ 150 MB on Streets).
2. **Error levels per cell** as separate chunks (the chunk header already has
   `level`/`error`/`cell`).
3. **Hidden-surface removal across cells**; treating glass as an occluder now
   that it is drawn solid.

Open, wanted eventually:

4. **Interiors**: simplified floors/walls/windows (decision 1).
5. **Colour**: un-premultiply cutout means; decals projected into the
   surface colour.
6. **Per-object picking on the overview** (source id per triangle).

### Phase 3 — runtime

- Per-cell LOD selection by **screen-space error** (same metric as the bake),
  with hysteresis/cross-fade. Frustum culling per cell already works (each
  cell is one mesh).
- Occlusion: mostly irrelevant top-down. For street level, use bake-time PVS
  per cell, or WebGL2 occlusion queries on cell bounds.
- **Streaming**: load cells by distance/priority; meshopt-compressed buffers
  (WASM decoder); HTTP compression.
- **Picking** on merged meshes: a per-triangle source ID → GPU ID-buffer pick
  → source table (scene, goPath, mesh, category).
- Integration into `web/` (TSX app) as a map backend. Player positions are
  already in Unity world space (see above).

### Open questions for the user

1. Are colours, ground colours, terrain relief and tree markers right now
   (brightness, saturation, line strength, tree size/opacity)? All are
   constants in `viewer/src/color.ts` and `viewer/src/scene.ts`, no rebuild
   needed to change them (tree size: `hlod.py`).
2. Where exactly are the remaining z-fighting spots / see-through windows on
   Streets (pick reports)?
3. Next larger step: integration into `web/`, interiors, or other maps?

## Validation checks

Automated in `extract/tests/test_build.py` (`ValidationChecksTest`, runs when
`cache/` is present) and `test_classify.py`:

- `ferma_big_end`: exactly one instance, ~29 m, scale ~0.06.
- `Pipe_filter_06_A_LOD0`: four instances, ~0.1 m, scale ~0.03; no giant 38 m
  pipes at the gate.
- `Enterance_Gate_01_L_LOD0` and its shadow keep correct matrices and meshes.
- `Treatment_Plant_outdoor_01_LOD0` → category `structure`, not foliage.
- `pine01_LOD0` / `Tree_pine01` → foliage.
- `Water_storage_01_A_LOD0` / `water_cooler` → structure;
  `Shoreline_Lake_Water_03_LOD0` / `Puddle_atlas_01_LOD0` → water.
- Customs explore totals: 141,088 instances, 91,989,746 triangles.

Use `compare_datasets.py <dirA> <dirB>` against a previous build when a change
is meant to be output-neutral (build the baseline on the same machine).
