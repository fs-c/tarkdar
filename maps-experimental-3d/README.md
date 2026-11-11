# Tarkdar — EFT 3D map spike

Extract real geometry from **Escape from Tarkov** and view it as a small 3D map.
This spike covers **Customs / `bigmap`** and **Streets / TarkovStreets** and
ships three modes:

- **overview** (default): LOD1 + decimation, built for 60 fps on an integrated
  GPU, with every mesh type kept.
- **explore**: the full, unfiltered dataset with a live **strip-down UI**. This
  is the mode to use when something looks missing or wrong.
- **inspect** (Customs): full LOD0 geometry with a click-to-identify picker.

No textures or materials are exported.

## What was extracted

Customs is not a single Unity scene. The build contains **23 additively loaded
scenes** (out of ~29 scene entries; scripts/sound/culling/AI scenes carry no map
geometry). Scene indices come from `BuildSettings` in
`EscapeFromTarkov_Data/globalgamemanagers`.

| level | scene | level | scene |
|---|---|---|---|
| 5 | `custom_multiScene` | 170 | `custom_Abandoned_Lab` |
| 6 | `custom_AZS` | 171 | `custom_Abandoned_Plant` |
| 7 | `custom_AZS_old` | 172 | `Custom_ChemicalFactory` |
| 8 | `custom_DesignStuff` | 173 | `Custom_Construction_Factory` |
| 9 | `custom_Garage` | 174 | `Custom_Expansion` |
| 10 | `custom_Obshezhitie` | 175 | `custom_Pump_Station` |
| 11 | `custom_Obshezhitie_1_indoor` | 176 | `Custom_RepairBox` |
| 12 | `custom_Obshezhitie_2_indoor` | 514 | `custom_DesignMain` |
| 13 | `custom_Light` / portals / stencils | | |
| 14 | `custom_Road` | | |
| 16 | `custom_Tamozhnya` | | |
| 17 | `custom_Terrain` + trees | | |
| 18 | `custom_TrailerPark` | | |
| 21 | `custom_factoryStorageZone` | | |
| 22 | `custom_mazuto` | | |

Skipped scene entries: `custom_Scripts` (15), `custom_Sound` (511),
`custom_Culling` (515), `custom_AI` (4, offline only), `custom_city` (20,
empty), and `custom_background` (19).

The geometry lives in `EscapeFromTarkov_Data/levelN` (scene),
`sharedassetsN.assets` (meshes) and `sharedassetsN.assets.resS` (streamed
vertex data). Unity version is **2022.3.43f2**.

**Streets of Tarkov** is the `Assets/Content/Locations/City/` scene group
(247 City scene entries, ~298k MeshRenderers). The `streets` preset is derived
from `BuildSettings` at extraction time:

- **full** (`streets`): 223 scenes, including all indoor scenes
- **exterior** (`streets-exterior`): 161 scenes, indoor scenes excluded
  (indoor scenes are ~52% of the renderers)

The shipped `streets` dataset is the full version; `--include-indoor` is the
switch that enables indoor scenes when regenerating.

## Current output

### overview (default)

Built for an integrated GPU at 1080p:

| metric | value |
|---|---:|
| LOD0 source instances | 93,000 |
| after LOD1 + 1 m prop filter | **49,597 instances** |
| mesh types | **3,126** |
| visible draw calls | ~3,123 |
| unique triangles | 1,014,692 |
| instanced triangles | **8,882,652** |
| binary + JSON | **22.6 MB + 8.0 MB** |
| measured | **~55–60 fps · 3,123 calls · 8.88M tris** |

Measured on the available integrated AMD GPU at 1500×950. The same profile
should have useful headroom on a discrete GPU.

How it is produced:

- choose **LOD1** where available (fall back to LOD0 if an asset has no LOD1)
- do **not** skip meshes by their `_LOD1/_LOD2` name (the LOD selector already
  filters LOD groups; the old name filter was deleting whole walls/roofs)
- drop instances below **1 m** max world dimension (configurable)
- decimate remaining meshes by **80%** with meshoptimizer (configurable)
- drop shadows, decals, skybox/background and unused geometry

Rare/small-mesh pruning is available via `--prune-min-instances`, but it is
**off by default**: testing showed it removed entire unique walls/roofs, even
though those are visually large. Decimation alone is enough to reach ~60 fps.

### Streets

| metric | full (`streets`) | exterior (`streets-exterior`) |
|---|---:|---:|
| scenes | 223 | 161 |
| instances | **64,200** | 37,778 |
| mesh types | 7,374 | 5,257 |
| unique triangles | 1,646,844 | 1,226,030 |
| instanced triangles | **14,045,252** | 8,997,128 |
| binary + JSON | **43.4 MB + 10.8 MB** | 32.5 MB + 6.6 MB |
| draw calls | ~7,314 | ~5,000 |
| measured | **~45–60 fps · 14.0M tris** | **60 fps · 9.0M tris** |

Streets is the stress benchmark: the full version includes all 223 City scenes
(including indoor geometry) and ~6.8k draw calls. The focused top view is
around 51 fps; the default perspective view is ~52–60 fps. The exterior variant
is a comfortable 60 fps.

### explore (live strip-down)

This is the dataset to use when something looks missing or wrong. It is the
**full, unfiltered** export, and the viewer lets you remove categories, scenes,
sizes and mesh types live.

| metric | Customs explore | Streets explore |
|---|---:|---:|
| geometry | LOD0 | LOD1 |
| scenes | 23 | 223 (incl. indoor) |
| instances | **134,749** | **161,178** |
| mesh types | 7,229 | 16,484 |
| instanced triangles | **89.6M** | **97.5M** |
| binary + JSON | 209.5 MB + 21.4 MB | 262.6 MB + 26.8 MB |
| includes | shadows, decals, background, small props | same |
| initial (everything on) | ~13 fps (filtered ~18) | ~12 fps (filtered ~24) |

Use the **Explore** button in the top bar, or open:

- Customs: `?mode=explore`
- Streets: `?mode=explore&map=streets`

Category matching is **token-based**, not substring-based. This avoids the
false positives we found: `Treatment_Plant_*`, `Street_Camera`, `Pinewood_*`,
`Window_*_leaf`, `Door_leaf` and `*_crash1` are structures, not foliage. Water
infrastructure (`water_pipe`, `water_storage`, `water_cooler`, `waterwell`, …)
is structure; only water surfaces (`lake`, `river`, `puddle`, `WaterForSSR`, …)
are water.

The left panel starts with every category visible. You can:

- toggle **structure / terrain / foliage / water / shadow / decal / background**
- filter by **world size** (min/max, plus **Huge >100 m** and **Tiny <0.5 m**
  presets)
- toggle **scene groups** (`custom_*`, `City_NE_01`, `City_Roads`, …)
- hide or solo by **mesh name**
- pick individual objects and use **Hide mesh** / **Solo mesh**
- **Copy filter** produces a JSON report of the exact current filter so it can
  be reproduced or baked into an export

This is intentionally heavy at the start; strip noise categories first to make
it responsive.

Recommended workflow:

1. Open **Explore** (Customs first).
2. Toggle **No noise** (shadow/decal/background) or individual categories.
3. Use **Huge >100 m** / **Tiny <0.5 m** to look for scale outliers.
4. Switch scene groups on/off, or hide/solo a mesh name.
5. Click an object with **Pick**; the panel reports mesh, scene, world position,
   world size, local scale and triangles.
6. **Copy report** for individual objects, or **Copy filter** to send me the
   exact filter state.

### inspect (Customs, optional)

Used by the picker. Full LOD0 geometry, no decimation or pruning:

| metric | value |
|---|---:|
| mesh types | 4,031 |
| instances | 93,000 |
| unique triangles | 7,547,991 |
| instanced triangles | 74,430,732 |
| binary + JSON | 173.5 MB + 14.4 MB |

Load it with `?mode=inspect`. It is intentionally heavy; it exists to identify
objects, not for navigation.

## Run it

Requires Python 3.14+ (uses the stdlib `compression.zstd`). The pipeline has
two stages:

1. **`extract_cache.py`**: game files → `cache/`. This is the only step that
   needs `EscapeFromTarkov_Data`. It is incremental: unchanged scenes are skipped.
2. **`build.py`**: `cache/` → `viewer/public/data/<name>/`. Needs only the cache,
   numpy and fast-simplification. It takes seconds per dataset.

`cache/` is stored in **Backblaze B2**, not git: the repo-root `assets.json`
lists every cache file by content hash, and `scripts/assets.py` fetches them
(see the root README, "Data files"). Machines without the game only run stage
2. Generated datasets in `viewer/public/data/` are gitignored.

### 1. Build datasets

```bash
cd maps-experimental-3d
make cache-pull                  # == ../scripts/assets.py pull cache
make install
make datasets                    # all six datasets (~35 s)
```

Or individually:

```bash
.venv/bin/python extract/build.py --map customs                        # overview
.venv/bin/python extract/build.py --map customs --profile inspect      # LOD0 picker data
.venv/bin/python extract/build.py --map customs --profile explore      # full, unfiltered
.venv/bin/python extract/build.py --map streets --include-indoor       # Streets full
.venv/bin/python extract/build.py --map streets --name streets-exterior
.venv/bin/python extract/build.py --map streets --profile explore --include-indoor --lod 1
```

### Re-extracting (only with the game installed)

```bash
make cache          # == extract/extract_cache.py --map customs --map streets
# options: --game-dir PATH, --only REGEX, --force
```

The default game path is
`/mnt/win/Battlestate Games/Escape from Tarkov/EscapeFromTarkov_Data`.
After a game patch, re-run `make cache`, then `make cache-push` (uploads
changed files to B2 and updates `assets.json`; commit that). Only changed
scenes and shards rewrite their cache files (output is deterministic), so
only those get uploaded.

### Cache contents

`cache/manifest.json` lists scenes (by path; `levelN` changes between patches),
map → scene lists and source-file provenance. Everything is stored in **Unity
space** (raw vertex data, original winding, Unity world matrices, row-major);
coordinate conversion happens in `build.py`.

- `meshes/<hh>.pack.zst`: a content-addressed mesh store with **all** LOD levels
  and collider meshes. It holds raw positions, normals in their source format,
  indices (baseVertex applied), submesh ranges/topology, and the extra vertex
  channels verbatim: vertex colour and UV0–UV7 where present (tangents and skin
  weights are dropped). `Mesh.attribute("uv0")` decodes one.
- `textures/<h>.pack.zst`: content-addressed RGBA8 thumbnails (≤128 px, box
  filtered, top row first) of every material colour texture (`_MainTex`-like
  slots) and terrain layer diffuse.
- `scenes/<path>.pack.zst`, per scene:
  - every MeshRenderer, including disabled/inactive ones (flags kept): mesh
    ref, world matrix, layer, hierarchy path, material names, cast-shadow mode,
    static-batch submesh range (`r_static_batch`, unused by EFT: all `[0, 0]`), lightmap
    index/scale-offset;
  - materials (`meta.materials`, via `r_material_ref`): shader name, render
    queue, keywords, all colour/float properties, texture slots with
    scale/offset → `meta.textures` (name, size, format, thumbnail hash, mean
    colour);
  - LOD groups (screen-relative heights, size) plus raw (renderer, group,
    level) memberships;
  - box/sphere/capsule/mesh colliders;
  - terrains: the raw int16 heightmap, holes, scale, matrix, terrain layers
    (diffuse thumbnail, tile size/offset), splat/alpha maps (≤1024 px, RGBA8),
    tree instances, and tree prototypes resolved to their prefab parts (mesh,
    matrix relative to the prefab root, materials, LOD level).

Not cached: full-resolution textures, normal/specular map pixels, tangents,
skinned meshes, lights, MonoBehaviours, Unity occlusion data. Adding them needs
a re-extract on a machine with the game.

The pack format (`t3d/pack.py`) is zstd-compressed: magic, JSON header, then
16-byte-aligned raw arrays.

### 2. View

```bash
cd viewer
npm install
npm run dev
```

Open the printed URL (usually `http://localhost:5173` or `5174`). The map
selector in the top bar switches between Customs, Streets and Streets exterior.

Controls:

- left drag: orbit
- right drag: pan
- wheel: zoom
- `R` reset · `T` top view · `F` wireframe · `V` vegetation · `G` grid
- **Inspect** button / `?mode=inspect`: load LOD0 + picker
- `P`: toggle pick mode · `Esc`: clear selection

## Inspect mode / picker

In `?mode=inspect`:

1. Click an object. A yellow box highlights it.
2. Shift-click to add more objects.
3. The panel shows mesh name, scene, world position, world size and triangles.
4. **Copy report** copies a JSON report to the clipboard. Paste it into chat
   and I can derive a filter rule.
5. **Hide mesh** / **Solo mesh** let you preview a rule immediately.
6. **Download** saves `selection-<map>.json`.

Report shape:

```json
{
  "map": "customs-inspect",
  "mode": "inspect",
  "selection": [
    {
      "mesh": "RoadSplineGenerator Generate",
      "meshIndex": 2250,
      "category": "structure",
      "scene": "level14",
      "sceneIndex": 9,
      "instance": 44483,
      "position": [204.77, 18.67, 53.22],
      "size": [59.08, 0.81, 43.48],
      "triangles": 1840
    }
  ]
}
```

Once a few objects are identified, the pattern becomes a filter such as
`--exclude-mesh 'RoadSplineGenerator*'`, a scene exclusion, or a size rule.

## Tuning knobs

```bash
build.py --map customs --decimate-ratio 0.5                      # more detail
build.py --map customs --decimate-ratio 0.85 --min-prop-size 1.5 # less detail
build.py --map customs --prune-min-instances 40                  # may remove unique walls/roofs
```

| flag | default (overview) | meaning |
|---|---:|---|
| `--map` | required | `customs` or `streets` |
| `--profile` | `overview` | `overview`, `inspect` or `explore` presets |
| `--include-indoor` | off | include Streets `*indoor*` scenes (Customs always includes its indoor scenes) |
| `--lod` | `1` | preferred LOD level (0, 1, 2, …) |
| `--min-prop-size` | `1.0` | drop instances smaller than this in world space (m) |
| `--decimate-ratio` | `0.8` | meshoptimizer reduction per mesh (0–0.95) |
| `--decimate-min-tris` | `200` | only decimate meshes above this triangle count |
| `--terrain-step` | `4` | heightmap downsample step |
| `--no-skip` | off | keep shadow/decal/background meshes |
| `--prune-min-instances` | `0` (off) | drop mesh types used fewer than N times, unless large |
| `--prune-min-size` | `25` | size (m) that protects a rare mesh type when pruning |
| `--out` / `--name` | per map/profile | output directory / file prefix |

The old `--merge-cell` bake was dropped: it duplicated shared geometry into a
421 MB binary.

## Output format

`customs.bin` contains per mesh:

- positions: `Float32` × 3 per vertex
- normals: `Int8` × 3 per vertex, normalized (saves 4× vs float32)
- indices: `Uint16` or `Uint32` per mesh
- optional vertex colors: `Uint8` × 3 (used by baked chunks)

`customs.json` describes the offset/count of each array, the mesh list, and the
instance matrices (column-major, ready for `THREE.Matrix4.fromArray`). Meshes
are deduplicated by a hash of positions+indices, so repeated fences, trees and
barrels are instanced rather than copied.

## Coordinate conversion

Unity uses a left-handed Y-up space; three.js uses right-handed Y-up. The
conversion is:

```
p_three = (x, y, -z)
M_three = S · M_unity · S      with S = diag(1, 1, -1, 1)
```

Because Unity's front faces are clockwise and the Z reflection also flips
winding, imported mesh triangles are reversed to be front-facing in three.js.
The generated terrain mesh is authored directly in three.js space and is not
reversed. This matters: before the fix, most surfaces were backface-culled and
the map looked hollow.

## Terrain

Two `Terrain` components in `level17` cover the central playable area
(1400 × 700 m). The surrounding ring is made from lower-resolution
`Terrain_Base` meshes. Both are exported and coloured as terrain.

The serialized heightmap values map to world height as:

```
local_y = raw_height / 32768 * heightmap_scale.y
world_y = terrain.transform.position.y + local_y
```

This was calibrated against tree placements in `level17` (median error ~1 cm).
Terrain is downsampled with `--terrain-step` (default 4 for overview).

## What was tried and rejected

- **`BatchedMesh` for all instances.** It reduced draw calls to 3 but ran at
  ~21 fps on the test GPU because it adds per-vertex texture lookups; the
  instanced path was faster.
- **Baking all instances into 100 m cells.** Correct geometry and ~151 draw
  calls, but shared geometry was duplicated into a 421 MB / 14.7M-vertex
  binary. Not practical for a download.
- **LOD2.** Many assets have no LOD2, and LOD1 fallback meant almost no
  triangle reduction. LOD1 + decimation was more effective.
- **Pruning rare/small mesh types by default.** It cut draw calls to ~592 and
  the download to 9 MB, but it removed many unique walls and roofs. The default
  now keeps all mesh types and uses decimation only.
- **Skipping `_LOD1`/`_LOD2` meshes by name.** This was a bug: the LOD selector
  already filters LOD groups, and the name filter was deleting the selected
  LOD1 meshes themselves. It caused missing smokestacks/walls/roofs. The name
  filter is gone; LOD selection handles it.
- **PPtr cache key collisions.** The mesh cache keyed only on
  `(assetsfile.name, path_id)`. Path IDs are only unique inside a file, so
  different external files with the same path ID collided. A gate shadow mesh
  `(file 14, path 466)` and a pipe filter `(file 3, path 466)` are a concrete
  example: the gate’s transform was paired with the pipe mesh, producing a
  giant “pipe” at the gate. The key now includes the level and `file_id`.
  This also removed the giant `ferma_big_end` instance.

## Known limitations / next steps

- **No textures or materials.** Everything is untextured shaded geometry.
- **Optional pruning is lossy.** `--prune-min-instances` can remove unique
  walls/roofs; it is off by default. Use the inspect profile to see everything.
- **LOD1 is still an approximation.** Some facade/roof detail is simplified
  compared with LOD0; use `--lod 0` if you need maximum detail at a
  performance cost.
- **Decimation is lossy.** Small props and some details are simplified. Reduce
  `--decimate-ratio` if it goes too far.
- **Background scene skipped.** A few out-of-bounds props/cranes still show at
  the edges.
- **Terrain seam.** The two heightmap slices have slightly different edge
  normals, visible in some views.
- **No collision/navmesh.** Physics and AI scenes were not exported.
- **Two maps.** Customs and Streets are wired in. Other locations need their
  scene list taken from `globalgamemanagers` / the location preset.
- **Streets indoor scenes dominate.** Indoor geometry is ~52% of the renderers.
  The full benchmark includes it; `--map streets` without `--include-indoor`
  produces the lighter exterior variant.
- **Explore is intentionally heavy.** The full Customs explore dataset is LOD0
  (94M tris) and Streets explore is LOD1 (102M tris). Use the category/scene/
  size filters to bring it down; start with **No noise** or **Huge >100m**.
- **Streets explore uses LOD1**, not LOD0, to keep the browser dataset
  manageable. Customs explore is LOD0.
- **Orientation.** Axes follow Unity world coordinates; aligning the view to
  the in-game pocket map (north-up/compass) is a follow-up.
