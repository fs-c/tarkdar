# 3D maps

The radar draws a raid on a 3D map built from the game's own geometry (`maps/3d/<folder>/`). A
location without one gets a grid of world coordinates in the same viewer instead: same camera,
controls and markers.

Available: **Customs** (`bigmap`) and **Streets** (`TarkovStreets`, exteriors only).

No calibration is involved: the datasets are in the game's world coordinates, the same space the
backend reports positions in. Checked against a recorded Customs raid: the median height of all
players above the 3D terrain is 5 cm.

## Where things are

```
maps/3d/<map>/            what the backend serves (build output, in the asset store, not in git)
  map.json                name + location ids: makes the backend list the folder
  index.json              dataset header
  chunk-0.t3d             geometry (compact: see "Dataset format")
  texture-N.png           terrain ground colour images
tools/maps3d/             the pipeline (Python) and the measurement harness
  extract_cache.py        stage 1: game files -> cache/        (needs the game + UnityPy)
  build.py                stage 2: cache/ -> maps/3d/<map>/    (no game needed)
  t3d/                    unity.py (scene walker), cache.py, pack.py (container),
                          classify.py, geometry.py, hlod.py (cells), visibility.py, dataset.py, maps.py
  tests/                  unittest
  cache/                  extraction cache (0.7 GB, in the asset store, not in git)
  harness/                screenshots + image metrics against a full-detail reference; frame times
web/src/map3d/            the renderer (three.js): container, dataset, Map3D, stage, tiles, instances, color
web/src/components/Radar.tsx     the map plus the marker overlay
```

## Using it

A machine that only runs the radar needs nothing but the built maps:

```sh
scripts/assets.py pull maps/3d
```

To rebuild them (Python 3.14+, a C++ compiler for the `meshoptimizer` package):

```sh
cd tools/maps3d
make cache-pull     # the extraction cache from the asset store
make install        # .venv
make maps           # both maps into maps/3d/, just under 4 min on 6 cores
make test
make publish        # upload maps/3d to the asset store; commit assets.json
```

`build.py --map customs --error 0.05` builds a finer map (about 7M triangles instead of 5M);
`--no-hsr`, `--cell-size`, `--include-indoor`, `--workers` are the other knobs.

Re-extraction (a game patch) needs a machine with `EscapeFromTarkov_Data`: `make cache`
(`GAME_DIR=...` if it is not at the default path), then `make cache-push`. `make list-scenes`
shows the BuildSettings scenes by location folder and the game's scene presets.

### Which scenes make a map

`t3d/maps.py` has a preset per map, with two separate choices, because only the first needs the
game:

- **Extraction** caches whole location folders (`folders`: every scene under
  `Assets/Content/Locations/<folder>/`, scripts, AI, culling and all) plus anything else the
  game's preset for the location loads. Re-extracting later means mounting the game again, and
  a scene in the cache costs little (meshes are shared by content).
- **The build** picks scenes from the cache (`select`). Customs, Streets and Factory have
  hand-checked lists; the other maps (`tuned: False`) take what **the game loads**: its
  `ScenesPreset` assets (`StreamingAssets/Windows/maps/*.bundle`, read by
  `unity.location_presets` and saved in the manifest as `gamePresets`, keyed by location id),
  minus scenes without map geometry (`NON_GEOMETRY_RE`: scripts, AI, sound, culling, quests,
  portals, stencil, grass, level borders). So a selection can be changed without the game.

Every scene a game preset names is in BuildSettings: no map geometry comes from asset
bundles. The manifest also keeps the whole BuildSettings list (`buildSettings`) and per scene
the count of each object type (`typeCounts`). Scenes do not reference NavMesh data
(`NavMeshSettings.m_NavMeshData` is null), so there is no navmesh to extract.

## In the frontend

- A location without a map shows a grid instead (`Map3D.load(null)`): lines every 50 m, stronger
  every 250 m, at height 0. Style, palette and the map debugging tools don't apply to it.
- Drag moves the map, the wheel zooms, right-drag (two fingers) tilts and turns it, `0` resets to
  top-down with north up, `+`/`-` zoom, `F` follows the local player.
- **Settings → Controls → WASD**: `W A S D` move along the ground (Shift: faster, speed follows the
  zoom), drag tilts and turns the camera, right-drag moves the map.
- **Settings → Projection**: perspective (25° field of view) or orthographic (parallel: buildings
  never lean). Switching keeps target, direction and zoom.
- **The style button** in the map's top right corner opens a row of the styles with a small
  preview of each: Realistic, the pre-made plan palettes, and your own palette if you made one
  (`components/StyleSwitch.tsx`). `M` switches between realistic and plan.
- **The follow button** (bottom right, `F`): off, it flies to the local player and follows them
  (`Map3D.flyTo`: the flight ends on the moving player, takes longer the further it goes, and zooms
  in when started from far out). While following it toggles **following the view direction**: the
  map turns so that the player's view points up (`Map3D.turnTo`). Moving the map by hand or `F`
  stops following; turning it by hand stops following the direction. Centring on something from a
  list or the timeline flies there as well.
- **Settings → Style**: **Realistic** shows what the place looks like (the game's material
  colours, lit); **Plan** is drawn like a map, for reading a situation at a glance (below). Same
  camera, same geometry: switching costs one frame.
- **Settings → Map colours**: colour schemes and sliders for the colour grade (below), live.
- Markers (players, loot, exfils, explosives, trails, labels) are drawn on a canvas over the map
  through the map's camera (`web/src/projector.ts`, `web/src/render.ts`). They show through
  buildings.
- **The map is rendered only when its camera or a setting changes.** Marker updates redraw the
  overlay only; while following, the map is re-rendered at most 30 times a second. A still camera
  costs the GPU nothing, which matters when the radar runs next to the game.
- **Orthographic and straight down** (the view during a raid) **is drawn from tiles**: a frame
  costs a twentieth of any other view's, and edges and outlines are smooth. See "The top-down
  view" below.
- **Settings → 3D map**: material colours, trees, contour lines. **Map debugging**: coordinate pick
  (click the map: world position, the mesh under the cursor and the camera, as JSON to paste into
  a bug report), wireframe, render statistics.
- three.js is loaded only when a 3D map is shown (a separate chunk, ~155 kB gzipped,
  including the decoder for the map files).

## Indoor maps

Factory, Labs, Labyrinth and Icebreaker (preset key `interior` in `t3d/maps.py`) are built with
everything kept: no hidden-surface removal, indoor scenes included (`index.json`:
`build.interior`). Such a map is readable one floor at a time, so the viewer **cuts it open**:

- `Map3D.setFloor(y)`: `y` is where someone stands (world height). Nothing from 2.3 m above it
  upwards is drawn (`stage.ts`: `uCut`, a `discard` in every material; ceilings face down and
  are culled anyway, what the cut removes is the floors and roofs above).
- The floor shown is the local player's: it follows once they are 0.4 m off it. The control
  above the follow button (or Page Up / Page Down) picks a height by hand in steps of 1 m;
  clicking the height goes back to automatic. Without a local player and without a pick the
  whole map is shown (the roof).
- The plan style measures heights from that floor instead of the ground map (`uFloor`): floor
  colour at the floor, cover up to 2 m, obstacle above. A part of the floor raised by half a
  metre or more (Labs has several) therefore shows as cover; what lies below is darker.
- There is no floor detection and no per-floor data: the cut height does all the work.
- The camera frames where nearly all objects are plus 25 m (`build.INTERIOR_MARGIN`).

Not yet: interiors of the buildings on outdoor maps (the mall on Interchange, Reserve's
bunkers, Streets): those maps are built from outside as before.

## How a map is built

1. **Cache** (`extract_cache.py`): every MeshRenderer of the map's scenes with its mesh (all LOD
   levels), world matrix, materials (shader, colours, texture thumbnails and their mean colour),
   LOD groups, colliders, terrains (heightmap, splat maps, layers, trees). Unfiltered and in Unity
   space; deterministic output. Not cached: full-resolution textures, normal maps, lights,
   occlusion data, other maps.
2. **Select** (`build.py`): LOD1 where a LOD group has it; a renderer listed in several levels is
   shown at each of them. Streets drops its `*indoor*` scenes.
3. **Classify** (`classify.py`), per material slot: structure, terrain, foliage, water, glass,
   shadow, decal, background, road. The shader name decides where it is unambiguous (`shadow*`,
   `Decal/*`, SpeedTree, water, glass); mesh-name tokens cover the rest.
4. **Cells** (`hlod.py`): structure, glass and road are merged per 128 m grid cell into world
   space; shadow, decal, background and foliage are dropped; terrain and water stay as they are.
   Scenery goes as well: objects wider than 800 m, and objects more than 150 m outside the
   playable area (the heightmap terrain, or what the map's `*_LevelBorders` scene encloses).
   Roads keep their up-facing triangles as authored (no simplification, no hidden-surface
   removal): they lie centimetres above the terrain.
5. **Simplify**: each cell with meshoptimizer to an absolute error of **10 cm**, with pruning:
   detached parts smaller than the error vanish, so there is no size cutoff for props.
6. **Hidden-surface removal** (`visibility.py`): a triangle is kept if a front-facing sample of it
   is nearest in a sampled depth buffer from one of 45 directions (sky hemisphere plus a ring
   looking slightly upwards, for undersides of canopies). Terrain hides what is buried. Other
   cells are not considered, so it errs on keeping.
7. **Finish**: vertices welded by position + colour (cells are flat shaded); material colour
   (albedo-thumbnail mean × `_Color`) baked per vertex; terrain ground colour image from splat
   maps × layer colours; one marker instance per tree of 3 m or more.
8. **Ground map** (`ground.py`), from the finished cells: see "The plan style".

| | Customs | Streets |
|---|---:|---:|
| source triangles (LOD1, structure + glass) | 40.4M | 39.2M |
| after simplification | 8.7M | 9.5M |
| after hidden-surface removal | 5.0M | 7.9M |
| cell meshes (≈ draw calls) | 108 | 101 |
| `chunk-0.t3d` | 18 MB | 23 MB |
| … as plain arrays (what the viewer holds, format 2's file size) | 148 MB | 217 MB |

The dataset holds the game's colours as they are (sRGB albedo means; median luma 0.3). The
viewer turns them into map colours **in the fragment shader** (`stage.ts`, `mapGrade`): luma →
lift + contrast × luma with the hue kept, then saturation, with an extra saturation factor for the
terrain's ground image. The values are settings (`settings.ts` `ColorGrade`, presets in
`COLOR_SCHEMES`), so changing them costs one frame: no reload, no rebuild. Terrain is then shaded
with slope, a height tint and 2 m contour lines. One exception: backdrop terrain without a ground
image has the average ground colour baked in at the default ground saturation (`hlod.py`).

## The plan style

A hand-drawn map is readable because it has few flat colours that say what a thing *is*, and
outlines. The material colours cannot do that: seen from above, a roof, the road next to it and
bare ground are the same grey-beige. The plan style gets there from geometry alone
(`stage.ts`, `PLAN_PARS` and `OUTLINE_FRAGMENT`):

- **Structure is coloured by its height above the ground**, not by its material: at floor level
  (under 0.3 m: pavements, slabs) the floor colour, varied a little by the material; up to 2 m
  the cover colour (what one can look over); above that the obstacle colour (walls, fences,
  containers, vehicles, pylons), or the building colour where a building stands, shading towards
  a second one with height (reached at 24 m).
- **Roads** are one colour (a little lighter for sand and slabs than for asphalt).
- **The colours are a palette** (`settings.ts` `PlanPalette`, **Settings → Plan palette**): six
  pre-made ones (Paper, Atlas, Mono, and the dark Night, Midnight, Blueprint), and every colour
  can be changed, which makes it a custom palette, stored with the other settings. The plan style
  is neither lit nor tone mapped: a level surface has exactly the palette's colour, walls are a
  little darker (`planShade`). The colour grade and exposure do not apply to it. The lights are
  switched off while it is shown (`Stage.setPlan`), so its shaders have no lighting in them: that
  was 40 % of a frame.
- **Terrain** has two flat colours, grass or bare ground, decided by the hue of the ground image,
  and only a hint of the relief shading. **Water** is one blue.
- **Outlines** come from the depth buffer after the map is drawn: a line where the surface steps
  towards or away from the camera, darker the higher the step. The threshold grows with the ground
  a pixel covers, so kerbs get a faint line close up and only buildings and walls do from afar.
  This is the one case where a frame is two passes (the map into a render target, then one
  full-screen pass); the realistic style renders straight to the screen as before.

"Height above the ground" and "a building stands here" come from the dataset's **ground map**
(`t3d/ground.py`), on a 1 m grid over the playable area plus 150 m:

1. Per cell, the lowest and highest up-facing surface of the baked map.
2. Ground seeds: heightmap terrain is ground. Elsewhere (all of Streets) a progressive
   morphological filter, the method that gets terrain out of LiDAR surfaces, removes what stands
   out of its surroundings: needed because under a roof the baked map has no floor left.
3. A surface that continues the ground without a step is ground too: a bridge deck, a ramp.
   What remains unknown (under buildings and vehicles) is filled in from around it.
4. Building = more than 2 m above that ground over at least 5 m in both directions.

It is single-valued: under a bridge the ground is the deck. Roofs one can walk onto from a slope
count as ground. A dataset without a ground map (built before this) shows all structure as
building in the plan style.

## The top-down view

With an orthographic camera looking straight down, moving and turning the camera only moves and
turns the picture. So the picture is kept (`web/src/map3d/tiles.ts`, and "Tiles" in `stage.ts`):

- **Tiles** are squares on a grid fixed to the world, 1024 texels each, painted once: the scene
  from a camera over the tile, then finished as a frame on screen would be (the plan style's
  outlines; tone mapping and sRGB for the realistic style). A frame is then one textured square
  per tile in view, about 20 of them.
- **They are painted at twice the size they are shown at** (two texels per device pixel in each
  direction, on top of 4× multisampling) and filtered down when drawn. That is the antialiasing,
  and it reaches what multisampling cannot: the outlines, which are found in the depth buffer,
  and the colour steps of the plan style. The outline pass looks one device pixel to each side
  (two texels), so lines are as wide as drawn directly; contour lines likewise (`uTexels`).
  A view whose tiles would take more than 200 MB (larger than 3440 × 1440) is painted at one
  texel per pixel: the same picture as drawn directly, but still only once.
- **Texels fall on screen pixels** while north (or east, south, west) is up: the picture is moved
  by up to half a pixel (`snapShift`). One bilinear tap per pixel is then exactly the mean of
  its four texels, and the map moves in whole pixels: edges do not crawl while following. Turned
  to any other angle the tiles are resampled.
- **A tile is good for one zoom and one look** (style, palette, colours, floor, trees…). When
  either changes, all tiles go; new ones are painted once it has stayed the same for 120 ms, so
  nothing is painted for a zoom step that the next one replaces.
- **A frame never waits for tiles.** If a tile in view is missing, the frame is drawn directly,
  as any other view is (on the same pixel grid, so nothing jumps when the tiles take over).
  Tiles are painted two per animation frame until the view has them, including a margin of 160
  pixels around it: following a player, a new row of tiles is painted every 20 seconds or so,
  before it is needed. Zooming and tilting are drawn directly.
- Tilted by more than a tenth of a degree, in perspective, or in wireframe there are no tiles.
  `0` goes back to straight down.

On the machine this was built on (Radeon 610M integrated graphics, 1920 × 1080; `bench.mjs` in
the harness), per frame while following a player, before and after:

| | Customs | Streets |
|---|---:|---:|
| realistic, before | 19 to 25 ms | 14 to 19 ms |
| plan, before (lit) | 25 to 31 ms | 21 to 27 ms |
| plan, drawn directly now (unlit) | 15 to 18 ms | 13 to 17 ms |
| either style, from tiles | 1.0 ms | 1.0 ms |
| painting the tiles of a view, once per zoom | 120 to 170 ms | 110 to 140 ms |

A frame is bound by pixels, not triangles, on such a GPU (2560 × 1440 took 38 to 46 ms), and an
empty frame takes 1 ms there: the tiles are at the floor. Drawing the markers takes 0.4 ms of
script per frame.

What it costs: up to 200 MB of GPU memory for the tiles of a view at two texels per pixel
(up to 100 MB at 1920 × 1080, 150 MB at 2560 × 1440) and 40 to 65 MB for the buffers a tile is
painted in (the plan style's are the larger: half floats and a depth texture).
The buffers of the direct rendering are given back after three seconds of frames from tiles.

## Dataset format

Format 3, written by `t3d/dataset.py`, read by `web/src/map3d/dataset.ts`.

- `index.json`: map, bounds and `focusBounds` (the playable area the camera frames), `categories`
  (ids are positions in this list), `stats`, `build` parameters, and the list of `chunks`.
- `chunk-0.t3d`: the `t3d/pack.py` container (magic, JSON header, 16-byte-aligned arrays),
  gzipped. Kind `instanced`; the arrays as the readers hand them on:
  - `mesh_*`: per mesh: vertex/index ranges, parts, local bounds, flags (1 = flat shaded)
  - `part_range`: submesh index ranges (one per material slot)
  - `positions` f32×3, `normals` i8×3, `indices16` / `indices32`, optional `colors` u8×4 (sRGB)
  - `ground_height` f32 and `ground_building` u8 (0 or 255), optional: the ground map, rows along
    z; the header's `ground` has its origin (x, z of the corner of cell 0, 0) and cell size
  - `inst_*`: per placed mesh: mesh, scene, world matrix (column-major 3×4)
  - `slot_*`: per (instance, part): category, flags, flat colour, material
  - header: `meshNames`, `meshTextures` (draped images with the local XZ rectangle they cover)
- **What is in the file** is an eighth of that (`_stored` in `dataset.py`); the readers
  (`dataset.read`, `loadMapData` → `decodeChunk` → `expandChunk`) undo it, so nothing downstream
  knows:
  - every mesh's triangles and vertices are put in vertex-cache order (`optimise`; unused vertices
    go), which is what makes the codecs below work;
  - `positions` are u16×4 (the 4th is padding): steps of a 65535th of the mesh's `mesh_bounds`
    per axis. That moves a vertex by at most 4 mm in a cell and 7 mm in the 1 km terrain;
  - `normals` are i8×4 (padding), all zero for flat shaded meshes;
  - `ground_height` is u16: steps of `ground.heightStep` (2 cm) above `ground.heightBase`, each
    row stored as differences to the cell before;
  - `positions`, `normals`, `colors` go through the meshoptimizer vertex codec and the index
    arrays through its index codec, one piece per mesh (`pack.Coded`; the header entry of such an
    array has `codec` and `segments`, and the pack has version 2). The viewer decodes them with
    the decoder three.js ships (`three/addons/libs/meshopt_decoder.module.js`);
  - the whole file is gzipped (level 9, no timestamp: the same dataset is the same file) and
    unpacked in the browser with `DecompressionStream`.
- Loading Streets from the backend takes about 0.25 s before anything reaches the GPU: 25 ms to
  fetch, 90 ms to gunzip, 100 ms for the codecs, 40 ms to expand (headless Chromium, no GPU).
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
`web/src/map3d` (terrain relief, solid glass) the current maps measure **0.896** (worst view
0.863) on Customs and **0.944** (worst 0.910) on Streets, with 148 and 110 draw calls. (Before
roads and tree markers, which the reference captures do not have: 0.912 and 0.945 with 114 and
108.) The compact format costs 0.001: the same maps as plain arrays measure 0.897 and 0.945, and
rendered side by side the two differ by SSIM 0.997, which is z-fighting speckle that falls
differently.

Frame times are measured by `harness/bench.mjs` (`node bench.mjs --data customs --settings
'{"style":"plan","orthographic":true}'`, `--no-tiles` for the direct rendering): see "The
top-down view" for the numbers. It prints the GPU it ran on; without one (SwiftShader) the times
mean nothing.

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
    a frame calls `requestRender()`. The animations (WASD movement, a flight, turning towards a
    direction) render per animation frame, but only until they arrive.
17. **Camera changes made by code go through `Map3D.own`** (or set `expectedTarget` first): the
    controls' change event cannot tell them from the user's, and "the user moved/turned the map"
    is what ends following.
13. **`GROUND_DESATURATION`** exists in `web/src/map3d/stage.ts` and `tools/maps3d/t3d/hlod.py`
    (backdrop terrain colour); keep them equal.

14. **Roads are "decals" by shader name only.** Customs' roads, pavements and concrete slabs are
    strips laid over the terrain with `Custom/Vert Paint SoftCutout Decal` (106,000 m², all level);
    the terrain's ground image under them is plain soil. Dropping them with the decals removed
    every road from the map. The same shader is on some rubble on Streets, hence "up-facing only".
    The viewer draws them with a polygon offset, since its terrain is coarser than the game's.
15. **The harness measures the realistic style.** `capture.mjs` renders the scene directly, without
    the outline pass; `shot.mjs` goes through `Map3D` and shows what the radar shows.
16. **Plan colours reach the shader as sRGB values** (not `THREE.Color`, which would convert):
    the plan formulas mix in sRGB. The standard material's lighting code is still there and its
    result is overwritten at the end of the fragment shader; with the lights off (`setPlan`) it
    does nothing.

28. **Whatever changes what the map looks like has to tell the tiles**: the setters of `Stage`
    count it (`content`); a change made from outside (what is drawn, a group hidden) calls
    `Stage.invalidate()`. Forgetting it shows as a top-down view that does not change until the
    next zoom.
29. **Anything in a shader that is measured in pixels** (line widths, `fwidth`, the outline's
    neighbours) is in texels while a tile is painted, two per pixel: multiply by `uTexels`, or
    lines come out half as wide in the top-down view as in a tilted one.
30. **A tile of the realistic style is rendered as the screen is** (tone mapped sRGB values in an
    8-bit buffer, blended as such): three.js does that for a render target marked
    `isXRRenderTarget`, which `Stage.paint` sets. Tone mapping after the fact instead blends the
    see-through tree markers in linear light, and they change shade when tiles take over. The
    target also needs `internalFormat: "RGBA8"`, or its multisampled buffer gets another format
    than its texture and cannot be resolved.
31. **The direct rendering of a flat view has to stay on the tiles' pixel grid** (`snapShift` in
    `Stage.renderDirect`), or the picture jumps by half a pixel each time tiles take over.
32. **`bench.mjs` must wait for the GPU every few frames** (a `readPixels`): hundreds of frames
    queued without it lose the WebGL context, and the numbers look wonderful.

18. **The index codec may return a triangle starting at another of its corners** (same winding).
    Nothing may depend on which vertex of a triangle comes first; comparisons of two datasets
    have to allow for it.
19. **The Python meshoptimizer binding's decoders trust their arguments**: `decode_vertex_buffer`
    allocates `count` elements of the dtype it is given (a one-byte dtype is a buffer overrun),
    and `decode_index_buffer` always returns u4 storage, half used for 2-byte indices. `pack.py`
    is the only place that calls them.
20. **`web/src/map3d/chunk.fixture.ts` is generated** (`python -m tests.web_fixture` in
    `tools/maps3d`): a chunk as the pipeline writes it and what the pipeline reads back, which
    the viewer's test must decode to the same numbers. A Python test fails when it is stale.
21. **Do not read the gunzipped stream with `new Response(stream).arrayBuffer()`**: in Chromium
    that sometimes takes two seconds for 40 MB; `readAll` in `dataset.ts` takes a tenth of one.

22. **A scene path can be in BuildSettings twice** (Terminal's are). The first level has the full
    `sharedassets`; the second's are stubs that refer to it. `extract_cache.py` takes the first.
23. **Game presets are flattened through their children**, and only a top-level `*.ScenesPreset`
    is a location: a child can carry a wrong `ServerName` (Factory's night culling preset says
    `factory4_day`), and the Customs bundle has an editor preset that says `Lighthouse`.
24. **`ServerName` is not always the location id**: Ground Zero's start variant is `Sandbox_SL`,
    its location id `sandbox_start`. Presets name their game preset (`game`).

25. **Anything that samples surfaces must clip them to its area first** (`geometry.clip_to_rect`).
    Sea floors and water are planes with triangles of 700 m and more; sampled whole at 0.5 m or
    less they take gigabytes (Lighthouse's ground map: 10 GB).
26. **The sea floor is "terrain" by its mesh name** (`Plane`) but not ground: with it as the lowest
    surface the ground map makes a port one building (`ground.SEA_FLOOR`).
27. **Some albedo slots have no thumbnail in cache v4**: the rock shaders' (`_Aldebo`,
    `_BaseAlbedoASmoothness`). Such a material's colour is its tint alone, i.e. white.

`tools/maps3d/tests/test_build.py` (`ValidationChecksTest`) checks known objects of the real
Customs cache when it is present (sizes, counts, categories).

## Decisions so far

- Geometry and level of detail of the cells are right as they are; faceted curves and missing
  thin things (wires, ladders) are fine. 10 cm stays.
- Colour on by default, lighter and more even than the raw material colours.
- Trees as markers only: "there is a tree there", not in the way.
- Interiors of indoor maps: everything kept, cut open at one floor in the viewer (see "Indoor
  maps"). Interiors of buildings on outdoor maps: not yet.
- No more time on optimization unless it is an easy win. The exception is the view a raid is
  played in (orthographic, straight down): that one is worth it, hence the tiles.
- Readability comes from a second style on the same geometry, not from a second (2D) map: what a
  thing is follows from its height above the ground, so no map needs hand-made data for it.

## Known limits

- Built and checked: Customs and Streets; Factory is a first version. Every other location is
  extracted (cache v4) but not yet tuned: see `docs/maps3d-handoff.md`.
- No interiors on outdoor maps: Streets is built from its exterior scenes, and hidden-surface
  removal strips what is under roofs. Glass is drawn solid for that reason.
- One level of detail; curved objects are faceted close up, thin objects are gone.
- The viewer still holds a map as plain arrays (148 MB and 217 MB in the browser, about 125 MB
  and 190 MB of that on the GPU); only the file is compact.
- The coordinate pick names the cell under the cursor, not the game object.
- Outlines of a tilted or perspective view are not antialiased (they are found per pixel in the
  resolved depth buffer); only the top-down view's are, through its tiles.
- While zooming the top-down view is drawn directly: full cost per frame, and the smooth picture
  comes back a third of a second after the zoom stops.
- The edge between the game's terrain (ground colour image) and the backdrop around it (one
  colour) is visible. Streets has no game terrain: its ground is ordinary geometry.

## If this is picked up again

In the order it would pay off:

1. **More maps** (needs the game): a preset per map, `make cache`, `make maps`, `make publish`.
2. **GPU memory**: hand the 16-bit positions to the GPU as they are (the scale goes into the
   instance matrix) instead of expanding them: 17 MB less on Customs, 24 MB on Streets. Cutting
   meshes at 65,535 vertices would halve the index memory as well, for 60 to 80 more draw calls.
3. **A faster bake**: hidden-surface removal is still nearly all of a build's CPU time
   (`visibility.py`, a sampled depth buffer in numpy); and a cache of baked cells keyed by their
   input would make a rebuild that changes nothing in a cell skip it.
4. **Interiors** as their own cells, shown with a cut above the local player's floor.
5. **Detail levels per cell** (the chunk header already has `level`, `error`, `cell`), and
   hidden-surface removal across cells.
6. **Per-object picking**: a source id per triangle.
