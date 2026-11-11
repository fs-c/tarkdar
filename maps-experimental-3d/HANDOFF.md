# Hand-off — EFT 3D map spike

Last updated: 2026-11-11 (cache v2 with materials/UVs/textures; data moved to B2)

## TL;DR

`maps-experimental-3d` extracts real Unity geometry from **Escape from Tarkov**
for **Customs / bigmap** and **Streets / TarkovStreets** and renders it in a
small three.js viewer. It is meant to replace the hand-calibrated 2D maps.

Where it stands:

- **Explore** mode with only *structure + terrain + water* visible is the
  quality bar: it looks right, but it is far too heavy (Customs 63M triangles /
  ~4k meshes, Streets 72M / ~9k meshes).
- **Overview** is fast (9–14M triangles) but visually broken: flat 80 %
  decimation without border locking tears meshes apart, and the 1 m prop cutoff
  removes things that matter.
- Pipeline: `extract_cache.py` (needs the game, done) → `cache/` (in B2) →
  `build.py` (no game). **All further work builds from `cache/` only**; see
  "Working without the game".
- Next: the roadmap below (Phase 0 restructure → Phase 1 measurement harness →
  Phase 2 offline simplification/HLOD → Phase 3 runtime LOD/streaming).

## Working without the game

The development machine has no game mount. Everything needed is in `cache/`,
which lives in Backblaze B2 (repo-root `assets.json`, `scripts/assets.py`;
credentials: root README, "Data files").

```bash
cd maps-experimental-3d
make cache-pull        # ~0.73 GB from B2
make install           # .venv (numpy, fast-simplification; UnityPy only for stage 1)
make datasets          # all six viewer datasets, ~35 s
make dev               # viewer
```

The cache was extracted on 2026-11-11 from Unity **2022.3.43f2** with
`EXTRACTOR_VERSION = 3` (`cache/manifest.json` records per-scene source file
sizes/mtimes). It holds deliberately more than today's build uses, so that the
phases below don't need the game; see "What the cache holds, per phase".
Re-extraction (new game patch, more maps, missing data) needs a machine with
`EscapeFromTarkov_Data`; afterwards `make cache-push` and commit `assets.json`.

## Locations and repository

- Project: `/home/fsoc/Projects/tarkdar/maps-experimental-3d` (repo `tarkdar`)
- Game data (only to re-extract):
  `/mnt/win/Battlestate Games/Escape from Tarkov/EscapeFromTarkov_Data`
- Viewer: http://localhost:5174/ (5173 is used by another project)
- Generated datasets live in `viewer/public/data/` and are **gitignored**
  (~0.8 GB).

## Layout

```
cache/                 extraction cache (B2 via ../assets.json, gitignored)
extract/
  extract_cache.py     stage 1: game files -> cache/ (needs UnityPy + game)
  build.py             stage 2: cache/ -> viewer dataset (no game needed)
  compare_datasets.py  byte/JSON diff of two datasets (parity checks)
  t3d/pack.py          deterministic zstd container format
  t3d/cache.py         manifest, scene files, mesh store, texture store
  t3d/unity.py         UnityPy scene walker (meshes, materials, textures, terrain)
  t3d/geometry.py      coordinate conversion, normals, terrain mesh, decimation
  t3d/classify.py      name-token classification rules
  t3d/maps.py          map presets (scene paths)
  requirements.txt     numpy, fast-simplification (+ UnityPy for stage 1)
viewer/
  index.html
  src/main.js          overview / explore / inspect, filters, picker (1.3k lines)
  src/style.css
  public/data/         generated datasets (gitignored)
docs/                  preview screenshots
Makefile
README.md              fuller reference (cache contents, flags)
```

## Viewer modes

| Mode | URL | Dataset |
|---|---|---|
| Customs overview | `/` | `customs` |
| Streets overview | `/?map=streets` | `streets` |
| Streets exterior | `/?map=streets-exterior` | `streets-exterior` |
| Customs explore | `/?mode=explore` | `customs-explore` |
| Streets explore | `/?mode=explore&map=streets` | `streets-explore` |
| Customs inspect/picker | `/?mode=inspect` | `customs-inspect` |

Explore has a left filter panel (categories, world size, scenes, mesh name,
Copy filter) and a right picker panel (click/Shift-click; Copy report, Hide /
Solo mesh). Picker reports include mesh, category, scene, position, size, scale
and triangles: the intended way for the user to report geometry problems.

## Datasets (current build.py output)

| Dataset | Geometry | Instances | Meshes | Triangles | Bin |
|---|---|---:|---:|---:|---:|
| `customs` | LOD1 + dec 0.8 | 49,597 | 3,126 | 8.9M | 22.6 MB |
| `customs-inspect` | LOD0 | 93,000 | 4,031 | 74.4M | 173.5 MB |
| `customs-explore` | LOD0, no skip/decimation | 134,749 | 7,229 | 89.6M | 209.5 MB |
| `streets` | LOD1 + dec 0.8, all City scenes | 64,200 | 7,374 | 14.0M | 43.4 MB |
| `streets-exterior` | LOD1 + dec 0.8, no indoor | 37,778 | 5,257 | 9.0M | 32.5 MB |
| `streets-explore` | LOD1, no skip/decimation, all City | 161,178 | 16,484 | 97.5M | 262.6 MB |

Explore restricted to structure + terrain + water (the quality bar):

| | Instances | Distinct meshes (≈ draw calls) | Triangles | Share of tris in objects > 20 m |
|---|---:|---:|---:|---:|
| Customs | 85k | 3,976 | 63.1M | 4 % |
| Streets | 95k | 9,308 | 71.5M | 3 % |

So the buildings that define the map are a small fraction of the cost; props
(barrels, wheels, garbage, fences, pipes, bricks) dominate. Integrated AMD GPU
at 1500×950: overview 45–60 fps, explore full 12–13 fps, explore filtered
17–24 fps.

## Pipeline

1. `extract_cache.py --map customs --map streets` (`make cache`). Reads the
   game, records everything unfiltered. Incremental per scene, deterministic
   output (identical bytes on re-run). ~7–13 min for both maps (texture decoding).
2. `build.py --map … --profile overview|inspect|explore` (`make datasets`).
   All filtering, LOD choice, decimation and coordinate conversion happen here.

Presets: Customs = 23 scene paths in `t3d/maps.py`. Streets = the 223 City
scenes from BuildSettings; the build drops `*indoor*` (leaving 161) unless
`--include-indoor`. Customs `*_indoor` scenes are always kept
(`indoorOptional: false`; they hold the dorm interiors/walls).

Parity: all six datasets built from the cache were byte-identical to the
legacy single-stage extractor (removed; `git log` has it) — both with the v1
cache and after the v2 re-extract.

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
3. **A renderer can belong to several LOD groups/levels.** The cache stores raw
   memberships; the build uses last-membership-wins (legacy behaviour). A
   bitmask merge silently dropped renderers.
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

## Known issues / limitations

- **Overview filters are heuristic and visually broken** (see TL;DR). Phase 2
  replaces them.
- **Two classifiers**: `t3d/classify.py` and a duplicate in `viewer/src/main.js`
  can drift. Phase 0 moves categories into the dataset.
- **No textures/materials in the viewer yet** (data is now cached).
- **Terrain seam** between the two central Customs heightmap slices.
- **Orientation** is Unity world space; not aligned to the in-game pocket map.
- **Inspect/picker is Customs-only.**
- **Other maps** need a preset/scene list and a re-extract with the game.

## Roadmap

Agreed in principle with the user; open questions at the end. Constraint
throughout: offline compute is cheap, the viewer must be light.

### Phase 0 — restructure (no visual change)

- Compute **category in build.py** (one classifier, extended with shader names:
  decals, cutout, transparent, water shaders) and write it per mesh/instance;
  delete the JS classifier.
- **Dataset format v2**: header JSON + binary chunks, designed for cells and
  LOD levels (Phase 2/3), carrying category, colour and a source-object table
  for picking. Consider glTF + `EXT_meshopt_compression` via gltfpack instead
  of a custom format: it gets compression and a decoder for free.
- Split `viewer/src/main.js` into modules (loader, scene/render, explore UI,
  picker, URL state); remove the dead batched/hybrid render paths. Optionally
  move to TypeScript to match `web/`.
- Tests: pack/cache round-trip, coordinate conversion, classifier tokens, and
  the "Validation checks" below as automated assertions over the cache/build.

### Phase 1 — reference + measurement harness

- A `reference` profile: explore restricted to structure + terrain + water
  (the user's quality bar) as visual ground truth.
- A headless harness (Playwright + the viewer): fixed camera set per map (top
  down, several 45° area views, a few street-level shots). It records
  `renderer.info` (triangles, draw calls), frame time and screenshots, and
  image-diffs each candidate against the reference (SSIM/PSNR per view). This
  turns "too many geometry issues" into numbers and catches regressions. Check
  that headless Chromium gets a hardware WebGL context on the new machine
  (otherwise SwiftShader still gives valid screenshots, not perf numbers).

### Phase 2 — offline simplification (the main lever)

Ordered by expected payoff:

1. **Screen-size culling of props.** Pick the target view distances. Drop or
   aggregate instances whose projected size is below N px at the nearest
   distance a cell is shown at. LOD group screen heights from the cache give
   the artists' own thresholds.
2. **Per-mesh error-bounded simplification**: prefer the artist LOD whose error
   fits. Otherwise use meshoptimizer `simplify` with a **target error** (not a
   ratio), **locked borders** and attribute (normal) weights. Python bindings
   (`meshoptimizer` on PyPI) or gltfpack. This replaces the flat 80 %
   decimation that tears meshes.
3. **Spatial cells + HLOD**: grid or quadtree cells (~64–128 m). Per cell and
   per category, merge all instance geometry into one mesh, weld, and simplify
   the merged mesh at several error levels (e.g. 2 cm / 10 cm / 50 cm / 2 m).
   Merging lets the simplifier remove faces between touching modular pieces,
   and cuts draw calls to cells × categories × levels.
4. **Bake-time hidden-surface removal**: render each cell offline from many
   viewpoints (sky hemisphere plus points above walkable ground) into an ID
   buffer. Drop triangles that are never visible (interiors, undersides,
   buried foundations). For far levels, consider voxel/SDF remeshing into
   watertight shells.
5. **Terrain**: replace the regular grid with an error-bounded TIN or quadtree
   chunks with skirts (Martini/Delatin-style), respecting holes. Colour it from
   splat maps × layer mean colours, baked into vertex colours or a small
   texture.
6. **Colour/material**: base colour per vertex from albedo `mean` × material
   colour (× vertex paint). Optional per-cell baked atlas from UV0 +
   thumbnails. Decals: drop, or project into the colour of the surface below.

### Phase 3 — runtime

- Per-cell LOD selection by **screen-space error** (same metric as the bake),
  with hysteresis/cross-fade; frustum culling per cell.
- Occlusion: mostly irrelevant top-down. For street level, use bake-time PVS
  per cell, or WebGL2 occlusion queries on cell bounds.
- **Streaming**: load cells by distance/priority; meshopt-compressed buffers
  (WASM decoder); HTTP compression.
- **Picking** on merged meshes: a per-vertex source ID → GPU ID-buffer pick →
  source table (scene, goPath, mesh, category).
- Integration into `web/` (TSX app) as a map backend. Player positions are
  already in Unity world space (see above).

### Open questions for the user

1. Are building interiors needed (street-level indoor view), or exteriors only?
   This decides HSR aggressiveness and whether `*_indoor` scenes stay.
2. Target GPU budget: proposal ≤ 5–10M visible triangles, ≤ 500 draw calls,
   ≤ 150 MB download per map, 60 fps on the integrated AMD GPU.
3. Viewer to TypeScript (matching `web/`)?
4. Primary camera: top-down/oblique only, or free street-level flight too?
   This decides the finest LOD needed.

## Validation checks

Sanity checks after regeneration (candidates for Phase 0 tests):

- `ferma_big_end`: exactly one instance, ~29 m, scale ~0.06.
- `Pipe_filter_06_A_LOD0`: four instances, ~0.1 m, scale ~0.03; no giant 38 m
  pipes at the gate.
- `Enterance_Gate_01_L_LOD0` and its shadow keep correct matrices and meshes.
- `Treatment_Plant_outdoor_01_LOD0` → category `structure`, not foliage.
- `pine01_LOD0` / `Tree_pine01` → foliage.
- `Water_storage_01_A_LOD0` / `water_cooler` → structure;
  `Shoreline_Lake_Water_03_LOD0` / `Puddle_atlas_01_LOD0` → water.
- `compare_datasets.py` against a previous build when a change is meant to be
  output-neutral.
