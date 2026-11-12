# 3D maps

The radar draws a raid on a 3D map built from the game's own geometry when the location has one
(`maps/3d/<folder>/`), and falls back to a calibrated 2D image (`maps/2d/`, see `docs/maps.md`)
or a plain world grid otherwise. The 2D maps are meant to go once every location has a 3D map.

Available: **Customs** (`bigmap`) and **Streets** (`TarkovStreets`, exteriors only).

No calibration is involved: the datasets are in the game's world coordinates, the same space the
backend reports positions in. Checked against a recorded Customs raid: the median height of all
players above the 3D terrain is 5 cm.

## Where things are

```
maps/3d/<map>/            what the backend serves (build output, in B2, not in git)
  map.json                name + location ids: makes the backend list the folder
  index.json              dataset header
  chunk-0.t3d             geometry
  texture-N.png           terrain ground colour images
tools/maps3d/             the pipeline (Python) and the measurement harness
  extract_cache.py        stage 1: game files -> cache/        (needs the game + UnityPy)
  build.py                stage 2: cache/ -> maps/3d/<map>/    (no game needed)
  t3d/                    unity.py (scene walker), cache.py, pack.py (container),
                          classify.py, geometry.py, hlod.py (cells), visibility.py, dataset.py, maps.py
  tests/                  unittest
  cache/                  extraction cache (0.7 GB, in B2, not in git)
  harness/                screenshots + image metrics against a full-detail reference
web/src/map3d/            the renderer (three.js): container, dataset, Map3D, stage, instances, color
web/src/components/Radar3D.tsx   the map plus the marker overlay
```

## Using it

A machine that only runs the radar needs nothing but the built maps:

```sh
scripts/assets.py pull maps/3d
```

To rebuild them (Python 3.14+, a C++ compiler for the `meshoptimizer` package):

```sh
cd tools/maps3d
make cache-pull     # the extraction cache from B2
make install        # .venv
make maps           # both maps into maps/3d/, about 4 min on 6 cores
make test
make publish        # upload maps/3d to B2; commit assets.json
```

`build.py --map customs --error 0.05` builds a finer map (about 7M triangles instead of 5M);
`--no-hsr`, `--cell-size`, `--include-indoor`, `--workers` are the other knobs.

Re-extraction (a game patch, another map) needs a machine with `EscapeFromTarkov_Data`:
`make cache` (7–13 min), then `make cache-push`. A new map needs a preset in `t3d/maps.py`: its
scene paths, its location `ids`, and whether `*indoor*` scenes are optional.

## In the frontend

- A location's 3D map wins over its 2D one; **Settings → Use the 2D map** switches back while both
  exist.
- Drag moves the map, the wheel zooms, right-drag (two fingers) tilts and turns it, `0` resets to
  top-down with north up, `+`/`-` zoom, `F` follows the local player.
- Markers (players, loot, exfils, explosives, trails, labels) are the 2D radar's, drawn on a canvas
  over the map through a projection (`web/src/projector.ts`): same code on both kinds of map. They
  show through buildings.
- **The map is rendered only when its camera or a setting changes.** Marker updates redraw the
  overlay only; while following, the map is re-rendered at most 30 times a second. A still camera
  costs the GPU nothing, which matters when the radar runs next to the game.
- **Settings → 3D map**: material colours, trees, contour lines. **Map debugging**: coordinate pick
  (click the map: world position, the mesh under the cursor and the camera, as JSON to paste into
  a bug report), wireframe, render statistics.
- three.js is loaded only when a 3D map is shown (a separate chunk, ~140 kB gzipped).

## How a map is built

1. **Cache** (`extract_cache.py`): every MeshRenderer of the map's scenes with its mesh (all LOD
   levels), world matrix, materials (shader, colours, texture thumbnails and their mean colour),
   LOD groups, colliders, terrains (heightmap, splat maps, layers, trees). Unfiltered and in Unity
   space; deterministic output. Not cached: full-resolution textures, normal maps, lights,
   occlusion data, other maps.
2. **Select** (`build.py`): LOD1 where a LOD group has it; a renderer listed in several levels is
   shown at each of them. Streets drops its `*indoor*` scenes.
3. **Classify** (`classify.py`), per material slot: structure, terrain, foliage, water, glass,
   shadow, decal, background. The shader name decides where it is unambiguous (`shadow*`,
   `Decal/*`, SpeedTree, water, glass); mesh-name tokens cover the rest.
4. **Cells** (`hlod.py`): structure and glass are merged per 128 m grid cell into world space;
   shadow, decal, background and foliage are dropped; terrain and water stay as they are.
5. **Simplify**: each cell with meshoptimizer to an absolute error of **10 cm**, with pruning:
   detached parts smaller than the error vanish, so there is no size cutoff for props.
6. **Hidden-surface removal** (`visibility.py`): a triangle is kept if a front-facing sample of it
   is nearest in a sampled depth buffer from one of 45 directions (sky hemisphere plus a ring
   looking slightly upwards, for undersides of canopies). Terrain hides what is buried. Other
   cells are not considered, so it errs on keeping.
7. **Finish**: vertices welded by position + colour (cells are flat shaded); material colour
   (albedo-thumbnail mean × `_Color`) baked per vertex; terrain ground colour image from splat
   maps × layer colours; one marker instance per tree of 3 m or more.

| | Customs | Streets |
|---|---:|---:|
| source triangles (LOD1, structure + glass) | 40.4M | 39.2M |
| after simplification | 8.7M | 9.5M |
| after hidden-surface removal | 5.0M | 7.9M |
| cell meshes (≈ draw calls) | 108 | 101 |
| `chunk-0.t3d` | 137 MB | 208 MB |

The viewer lifts the baked colours (`web/src/map3d/color.ts`: luma → 0.36 + 0.58 × luma, hue
kept; the raw means have a median luma of 0.3) and shades terrain with slope, a height tint and
2 m contour lines (`stage.ts`). These are viewer constants: no rebuild to change them.

## Dataset format

Format 2, written by `t3d/dataset.py`, read by `web/src/map3d/dataset.ts`.

- `index.json`: map, bounds and `focusBounds` (the playable area the camera frames), `categories`
  (ids are positions in this list), `stats`, `build` parameters, and the list of `chunks`.
- `chunk-0.t3d`: the `t3d/pack.py` container (magic, JSON header, 16-byte-aligned arrays), not
  compressed, so the browser uses the arrays in place. Kind `instanced`:
  - `mesh_*`: per mesh: vertex/index ranges, parts, local bounds, flags (1 = flat shaded)
  - `part_range`: submesh index ranges (one per material slot)
  - `positions` f32×3, `normals` i8×3, `indices16` / `indices32`, optional `colors` u8×4 (sRGB)
  - `inst_*`: per placed mesh: mesh, scene, world matrix (column-major 3×4)
  - `slot_*`: per (instance, part): category, flags, flat colour, material
  - header: `meshNames`, `meshTextures` (draped images with the local XZ rectangle they cover)
- In a built map the "meshes" are the merged cells, each placed once with an identity matrix; the
  format is the same for the harness's full-detail reference, where meshes are the game's and
  instanced.
- Everything is in the renderer's space: game world coordinates with **z negated**.

## Measuring quality

`tools/maps3d/harness/` (its README has the details) renders a dataset from 18 fixed cameras per
map in headless Chromium and compares it with a **reference**: every renderer at full detail,
restricted to structure, terrain, water and glass. It reports structural similarity (SSIM),
triangles and draw calls per view.

```sh
cd tools/maps3d
make install-harness
make reference-data          # the reference datasets (harness/data/)
make harness-serve           # in another terminal
make reference               # capture the reference, ~15 min without a GPU
make measure MAP=customs
```

What the measurements decided (Customs, mean SSIM / triangles for the whole map):

| variant | SSIM | triangles |
|---|---:|---:|
| first overview: per-mesh 80 % decimation, 1 m prop cutoff (removed) | 0.834 | 7.5M |
| cells at 2 / 5 / 10 / 25 / 50 cm, original normals, nothing removed | 0.951 / 0.930 / 0.914 / 0.889 / 0.866 | 20.6M / 11.8M / 9.0M / 6.6M / 4.9M |
| 10 cm starting from LOD0 instead of LOD1 | 0.911 | 11.8M |
| 10 cm + hidden-surface removal | 0.913 | 6.2M |
| … + flat shading | 0.924 | 6.2M |
| … + buried geometry removed (current) | 0.924 | 5.3M |

So LOD1 is the right base, hidden-surface removal is free in quality, and flat shading beats
carrying the original normals through simplification (they left dark patches) while nearly
halving the vertex count.

The table is from the standalone viewer these maps were developed in. With the renderer in
`web/src/map3d` (terrain relief, solid glass) the current maps measure **0.912** (worst view
0.873) on Customs and **0.945** (worst 0.912) on Streets, with 114 and 108 draw calls.

Frame rates were never measured on a GPU by the harness (the development container has none).

## Things that are easy to get wrong

1. **Do not skip `_LOD1`/`_LOD2` meshes by name.** LOD groups are filtered by the LOD selection;
   name-skipping deleted selected meshes.
2. **PPtr keys must resolve the target file** (`unity.py`). Path ids are only unique within a
   file; keying by the referencing file produced giant phantom objects.
3. **A renderer can be in several LOD levels and groups.** It is shown when any membership is the
   level chosen for that group. "Last membership wins" dropped the chemical factory's brick walls
   at LOD0 and its roof at LOD1.
4. **Coordinates**: positions `(x, y, -z)`, matrices `S · M · S` with `S = diag(1, 1, -1, 1)`,
   imported triangle winding reversed. Generated terrain is authored directly in the renderer's
   space.
5. **Terrain heights**: `local_y = raw / 32768 * heightmap_scale.y`.
6. **Category matching is token-based**, not substring-based (`plant` in `Treatment_Plant` is not
   foliage), and **shader rules come before name rules**: names alone mislabelled thousands of
   shadow proxies, decals and plants as structure.
7. **Category is per material slot**: about 5 % of renderers mix categories across submeshes.
   Submesh k uses material k; Unity repeats the last material.
8. **Category ids are positions in `classify.CATEGORIES`**: append, never reorder.
9. **Texture thumbnails are top row first**; terrain splat maps have row 0 at local z = 0.
10. **Visibility samples must be denser than the pixel grid** (0.7 × pixel) and cell-centred in
    the triangle, or holes in the depth buffer keep hidden geometry (never the reverse).
11. **One BLAS thread per cell worker** (`hlod.bake` sets `OPENBLAS_NUM_THREADS=1`); otherwise the
    bake takes over ten minutes instead of about one.
12. **The map must not render on a timer.** `Map3D` renders on request only; anything that needs
    a frame calls `requestRender()`.
13. **`GROUND_DESATURATION`** exists in `web/src/map3d/stage.ts` and `tools/maps3d/t3d/hlod.py`
    (backdrop terrain colour); keep them equal.

`tools/maps3d/tests/test_build.py` (`ValidationChecksTest`) checks known objects of the real
Customs cache when it is present (sizes, counts, categories).

## Decisions so far

- Geometry and level of detail of the cells are right as they are; faceted curves and missing
  thin things (wires, ladders) are fine. 10 cm stays.
- Colour on by default, lighter and more even than the raw material colours.
- Trees as markers only: "there is a tree there", not in the way.
- Interiors: not needed now. The ideal version has simplified interiors (floors, walls, windows).
  None of the 2D maps in use has more than one floor configured, so nothing is lost meanwhile.
- No more time on optimization unless it is an easy win.

## Known limits

- Customs and Streets only. Factory, Ground Zero and Woods still use their 2D maps.
- No interiors: Streets is built from its exterior scenes, and hidden-surface removal strips what
  is under roofs. Glass is drawn solid for that reason.
- One level of detail; curved objects are faceted close up, thin objects are gone.
- Maps are not compressed: 137 MB and 208 MB over HTTP, fine on localhost or a LAN.
- The coordinate pick names the cell under the cursor, not the game object.
- The edge between the game's terrain (ground colour image) and the backdrop around it (one
  colour) is visible. Streets has no game terrain: its ground is ordinary geometry.

## If this is picked up again

In the order it would pay off:

1. **More maps** (needs the game): a preset per map, `make cache`, `make maps`, `make publish`;
   then the 2D map of that location can go. When all are covered: delete `Radar2D`
   (`RadarCanvas.tsx`), `calibration.ts`, `view.ts`, `maps/2d` and `docs/maps.md`.
2. **Compression**: per-cell int16 positions and meshopt vertex/index codecs (the Python bindings
   encode, the `meshoptimizer` npm package decodes) behind the chunk header: roughly 30–50 MB a
   map.
3. **Interiors** as their own cells, shown with a cut above the local player's floor.
4. **Detail levels per cell** (the chunk header already has `level`, `error`, `cell`), and
   hidden-surface removal across cells.
5. **Per-object picking**: a source id per triangle.
