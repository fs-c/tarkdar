# Tarkdar — EFT 3D map spike

Extract real geometry from **Escape from Tarkov** and view it as a small 3D map.
This spike covers **Customs / `bigmap`** and **Streets / TarkovStreets** and
ships three modes:

- **overview** (default): the map as merged 128 m cells: simplified to a
  10 cm error bound, hidden surfaces removed, ~110 draw calls per map.
- **explore**: the full, unfiltered dataset with a live **strip-down UI**. This
  is the mode to use when something looks missing or wrong.
- **inspect** (Customs): full LOD0 geometry with a click-to-identify picker.

No textures are shown; the datasets carry a category and a flat colour per
material slot (the overview: per vertex). `HANDOFF.md` has the current state,
the measurements and the roadmap; `harness/README.md` describes how quality
is measured.

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

- **all** City scenes: 223, including the indoor scenes (~52% of the
  renderers). Used by `streets-explore`.
- **exterior**: 161 scenes, indoor scenes excluded. Used by the `streets`
  overview; `--include-indoor` adds the indoor scenes.

## Current output

### overview (default)

| metric | Customs (`customs`) | Streets (`streets`, exteriors) |
|---|---:|---:|
| source triangles (LOD1, structure + glass) | 40.4M | 39.2M |
| after simplification (10 cm) | 8.7M | 9.5M |
| after hidden-surface removal | **5.0M** | **7.9M** |
| triangles incl. terrain/water | 5.3M | 7.9M |
| cell meshes / draw calls | 108 / ~114 | 101 / ~108 |
| geometry file | 136.8 MB | 207.7 MB |
| mean / min SSIM vs the reference | 0.924 / 0.874 | 0.944 / 0.910 |

How it is produced (`extract/t3d/hlod.py`, `visibility.py`):

- choose **LOD1** where available; a renderer listed in several LOD levels is
  shown at each of them
- drop the shadow, decal, background and foliage **categories** (classified
  from shader and mesh names, see "Output format")
- merge structure and glass per **128 m cell** into world space
- simplify each cell with meshoptimizer to an **absolute error of 10 cm**
  (`--error`); detached props smaller than the error vanish, so there is no
  size cutoff
- remove triangles that are **never visible** from 45 directions around and
  above the map (terrain hides buried parts); `--no-hsr` turns it off
- flat shading, vertices shared by position + baked material colour

Terrain and water stay as they are. Trees become simple translucent markers
(one per foliage object of 3 m or more); other vegetation is dropped. SSIM is measured by the harness against
the explore dataset restricted to structure + terrain + water + glass; the
first overview (`--profile legacy`, `make legacy`, `?map=customs-legacy`)
scores 0.834 / 0.733 with 2,656 / 5,314 draw calls.

Frame rates have not been re-measured (the development container has no GPU).

### explore (live strip-down)

This is the dataset to use when something looks missing or wrong. It is the
**full, unfiltered** export, and the viewer lets you remove categories, scenes,
sizes and mesh types live.

| metric | Customs explore | Streets explore |
|---|---:|---:|
| geometry | LOD0 | LOD1 |
| scenes | 23 | 223 (incl. indoor) |
| instances | **141,088** | **164,702** |
| mesh types | 7,930 | 17,106 |
| instanced triangles | **92.0M** | **98.1M** |
| chunk + index | 214.8 MB + 0.1 MB | 278.5 MB + 0.4 MB |
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

- toggle **structure / terrain / foliage / water / glass / shadow / decal /
  background** (a category is per material slot, so a decal or glass submesh
  inside a wall mesh is switched separately from the wall)
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
5. Click an object with **Pick**; the panel reports mesh, category, shader,
   scene, hierarchy path, world position, world size, local scale and triangles.
6. **Copy report** for individual objects, or **Copy filter** to send me the
   exact filter state.

### inspect (Customs, optional)

Used by the picker. Full LOD0 geometry, no decimation or pruning:

| metric | value |
|---|---:|
| mesh types | 4,176 |
| instances | 94,194 |
| unique triangles | 7,591,681 |
| instanced triangles | 74,715,405 |
| chunk + index | 169.7 MB + 0.1 MB |

Load it with `?mode=inspect`. It is intentionally heavy; it exists to identify
objects, not for navigation.

## Run it

Requires Python 3.14+ (uses the stdlib `compression.zstd`). The pipeline has
two stages:

1. **`extract_cache.py`**: game files → `cache/`. This is the only step that
   needs `EscapeFromTarkov_Data`. It is incremental: unchanged scenes are skipped.
2. **`build.py`**: `cache/` → `viewer/public/data/<name>/`. Needs only the cache,
   numpy and meshoptimizer (a source-only package: `pip` needs a C++
   compiler). Seconds per dataset; the overview takes one to three minutes.

`cache/` is stored in **Backblaze B2**, not git: the repo-root `assets.json`
lists every cache file by content hash, and `scripts/assets.py` fetches them
(see the root README, "Data files"). Machines without the game only run stage
2. Generated datasets in `viewer/public/data/` are gitignored.

### 1. Build datasets

```bash
cd maps-experimental-3d
make cache-pull                  # == ../scripts/assets.py pull cache
make install
make datasets                    # the five datasets (~4 min on 6 cores)
make test                        # unit tests (extract + viewer)
```

Or individually:

```bash
.venv/bin/python extract/build.py --map customs                        # overview (merged cells)
.venv/bin/python extract/build.py --map streets                        # overview, exterior scenes
.venv/bin/python extract/build.py --map customs --profile inspect      # LOD0 picker data
.venv/bin/python extract/build.py --map customs --profile explore      # full, unfiltered
.venv/bin/python extract/build.py --map streets --profile explore --include-indoor --lod 1
.venv/bin/python extract/build.py --map customs --profile legacy       # first, decimated overview
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

Open http://localhost:5174/ (`make dev` from the project root does the same). The map
selector in the top bar switches between Customs and Streets; any dataset
directory also works as `?map=<name>`.

Controls:

- left drag: orbit
- right drag: pan
- wheel: zoom
- `R` reset · `T` top view · `F` wireframe · `V` vegetation · `G` grid
- `C` / **Colour** (on by default): material colours (albedo mean × tint,
  lifted to a lighter, more even range) instead of the per-category colours
- **Inspect** button / `?mode=inspect`: load LOD0 + picker
- `P` / **Pick** (on by default): click a point to get its game world
  coordinates; Shift-click adds more; **Copy report** includes the object
  under each point and the camera · `Esc`: clear selection
- `?cam=x,y,z,tx,ty,tz` opens a camera pose from a report; `?color=0` starts
  with category colours

Terrain shows its real ground colours (grass, dirt, gravel, roads: the
terrain layers' mean colours blended by the game's splat maps), slope
shading, a height tint and 2 m contour lines.

Inspect hides the shadow, decal and background categories by default (the
overview does not contain them); explore starts with everything visible.

## Inspect mode / picker

In `?mode=inspect`:

1. Click an object. A yellow box highlights it.
2. Shift-click to add more objects.
3. The panel shows mesh name, category, shader, scene, hierarchy path, world
   position, world size and triangles.
4. **Copy report** copies a JSON report to the clipboard. Paste it into chat
   and I can derive a filter rule.
5. **Hide mesh** / **Solo mesh** let you preview a rule immediately.
6. **Download** saves `selection-<map>.json`.

Report shape:

```json
{
  "map": "customs-inspect",
  "mode": "inspect",
  "camera": { "position": [260.0, 60.0, -10.0], "target": [204.0, 18.0, -52.0] },
  "selection": [
    {
      "point": [204.1, 18.9, -52.7],
      "unity": [204.1, 18.9, 52.7],
      "mesh": "RoadSplineGenerator Generate",
      "meshIndex": 2250,
      "category": "structure",
      "material": "road_asphalt",
      "shader": "p0/Reflective/Bumped Specular SMap",
      "scene": "level14",
      "sceneIndex": 9,
      "path": "Roads/RoadSplineGenerator Generate",
      "instance": 44483,
      "position": [204.77, 18.67, 53.22],
      "size": [59.08, 0.81, 43.48],
      "scale": [1, 1, 1],
      "triangles": 1840,
      "partTriangles": 1840
    }
  ]
}
```

Once a few objects are identified, the pattern becomes a filter such as
`--exclude-mesh 'RoadSplineGenerator*'`, a scene exclusion, or a size rule.

## Tuning knobs

```bash
build.py --map customs --error 0.05            # finer overview (about 7M triangles)
build.py --map customs --error 0.25            # coarser (about 4M)
build.py --map streets --include-indoor        # overview with the indoor scenes
```

| flag | default | meaning |
|---|---:|---|
| `--map` | required | `customs` or `streets` |
| `--profile` | `overview` | `overview`, `inspect`, `explore` or `legacy` |
| `--include-indoor` | off | include Streets `*indoor*` scenes (Customs always includes its indoor scenes) |
| `--lod` | `1` (overview) | preferred LOD level (0, 1, 2, …) |
| `--error` | `0.10` | overview: simplification error bound in metres |
| `--cell-size` | `128` | overview: cell size in metres |
| `--no-hsr` | off | overview: keep triangles that are never visible |
| `--workers` | CPUs | overview: worker processes |
| `--terrain-step` | `4` | heightmap downsample step |
| `--min-prop-size`, `--decimate-ratio`, `--decimate-min-tris`, `--no-skip` | | legacy/inspect filters (size cutoff, per-mesh decimation, noise names) |
| `--prune-min-instances`, `--prune-min-size` | off | drop rare mesh types; removes unique walls/roofs |
| `--out` / `--name` | per map/profile | output directory / dataset name |

## Output format

Dataset **format 2** (`extract/t3d/dataset.py` writes it, `viewer/src/dataset.ts`
reads it). One directory per dataset under `viewer/public/data/<name>/`:

| file | content |
|---|---|
| `index.json` | small header: map, bounds, `categories`, `scenes`, `materials` (name, shader, render queue), `stats` (incl. per-category triangles) and the list of `chunks` |
| `chunk-0.t3d` | geometry chunk: the `t3d/pack.py` container (magic, JSON header, 16-byte-aligned arrays), uncompressed so the browser can use the arrays in place |
| `sources.json` | hierarchy paths (`goPath`) per instance; the picker fetches it on the first click |
| `texture-N.png` | colour image draped over mesh N (terrain ground colour, 1024², ~0.75 MB); listed in the chunk header as `meshTextures` with the local XZ rectangle it covers |

A chunk is self-describing (`kind`, `level`, `error`, `cell` in its header),
so Phase 2/3 can add one chunk per spatial cell and LOD level. Today there is
one chunk of kind `instanced`:

- `mesh_*`: per unique mesh: vertex/index ranges, parts, local bounds. Meshes
  are deduplicated by a hash of positions + indices + parts, so repeated
  fences, trees and barrels are instanced rather than copied.
- `part_range`: the submesh index ranges of a mesh (one per material slot).
- `positions` `Float32`×3, `normals` `Int8`×3 (normalized), `indices16` /
  `indices32` (a mesh uses 32-bit indices above 65,536 vertices).
- `inst_*`: per placed renderer: mesh, scene, hierarchy path and the world
  matrix as column-major 3×4 `Float32`.
- `slot_*`: per (instance, part): **category** id, flags (cutout,
  transparent), flat **colour** (albedo thumbnail mean × `_Color`, sRGB bytes,
  alpha 0 = unknown) and material id.
- `mesh_flags` (1 = flat shaded, normals unused) and `colors` (per-vertex
  sRGB, parallel to `positions`): written by the overview, whose "meshes" are
  the merged cells, each placed once with an identity matrix.

Categories are computed once, in `extract/t3d/classify.py`: the shader name
decides where it is unambiguous (`shadow*` → shadow, `Decal/*` → decal,
SpeedTree → foliage, water and glass shaders), mesh-name token rules cover the
rest. The viewer has no classifier of its own.

`extract/compare_datasets.py <dirA> <dirB>` reports whether two datasets are
identical, and otherwise which header keys or arrays differ.

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

See `HANDOFF.md` ("Known issues / limitations", "Roadmap"). In short: the
overview is not compressed yet (137 / 208 MB), has a single level of detail
(faceted close up, no thin details), trees only as markers, exteriors only on
Streets, and picking there returns coordinates and a cell rather than an
object. Explore and inspect
are intentionally heavy (92–98M triangles); they exist to examine the source
geometry, not to navigate. Axes follow Unity world coordinates.
