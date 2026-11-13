# Handoff: every location as a 3D map

State on 2026-11-13. Background and pipeline: `docs/maps3d.md`.

The work is split in two. **Phase A** needed the game files and is done. **Phase B** needs only
the extraction cache from the asset store, and can run on any machine.

## Done (Phase A)

- **Every location is extracted** (cache v4: 686 scenes, 1.78 GB, pushed; `assets.json`).
  Get it with `cd tools/maps3d && make cache-pull`.
- **Scene choice moved to build time.** Extraction takes whole location folders plus whatever
  the game's own scene preset for the location names. A preset in `t3d/maps.py` then picks the
  scenes it builds from the cache (`select`). Customs, Streets and Factory keep their
  hand-checked lists. The others (`tuned: False`) use the game's preset (manifest `gamePresets`)
  minus scenes without map geometry (scripts, AI, sound, culling, …).
- **Presets** for Woods, Shoreline, Interchange, Reserve, Lighthouse, Ground Zero, Ground Zero
  start, Labs, Labs event, Labyrinth, Terminal, Icebreaker, Factory event.
- **No regression:** Customs and Streets built from the new cache are byte-identical to the
  committed code on the old cache.
- **Smoke builds** (no hidden-surface removal) of all 13 new maps, with a top-down look at each.
  Nothing is missing: outdoor maps are complete; indoor maps show only roofs and top floors.

| map | triangles (no HSR) | build |
|---|---:|---:|
| Woods (with HSR) | 3.5M | 313 s |
| Shoreline | 7.4M | 32 s |
| Interchange | 16.4M | 30 s |
| Reserve | 8.5M | 24 s |
| Lighthouse | 11.4M | 45 s |
| Ground Zero / start | 4.2M / 1.4M | 12 / 7 s |
| Labs / event | 3.2M / 3.4M | 11 / 12 s |
| Labyrinth | 0.6M | 6 s |
| Terminal | 28.5M | 43 s |
| Icebreaker | 0.6M | 6 s |
| Factory event | 1.1M | 5 s |

```sh
cd tools/maps3d
.venv/bin/python build.py --map shoreline --no-hsr --out harness/data/shoreline-smoke
make harness-serve    # then: cd harness && node shot.mjs --data shoreline-smoke --out /tmp/s
```

## Left to do (Phase B, no game needed)

1. **Huge backdrop objects.** Shoreline's full build was OOM-killed (25 GB): a 12 km bridge
   (`Tarkov_city_background`) and 1.7 km `Mount_01` meshes are classified as structure, so their
   cell spans kilometres and hidden-surface removal rasterises that at 20 cm. Lighthouse and
   Terminal have the same kind of backdrop (Terminal: 4.2 × 2.2 km ground map). Options: treat
   oversized or far-outside-the-playable-area objects as background (pass through or drop),
   or split or cap a cell's extent before HSR. Until then, run builds under a memory cap
   (`systemd-run --user --scope -p MemoryMax=32G …`).
2. **Tune each outdoor map**: Woods, Shoreline, Interchange, Reserve, Lighthouse, Ground Zero,
   Terminal. Check scene choice and categories (sea water, new shaders), `make_views.py` +
   reference + `make measure`, look at it in the radar, then build into `maps/3d/<map>`,
   `make publish`, and drop its 2D map. Set `tuned` once a map has been looked at.
3. **Customs:** the game also loads `custom_city` and `custom_background`, which the hand list
   leaves out. Check whether they add anything worth showing.
4. **Variants:** Labs event, Factory event and Ground Zero start are separate presets for now.
   Decide per variant: an extra location id on the main map, or a map of its own.
   (`laboratory_dark` and `Sandbox_high` are already ids of Labs and Ground Zero.)
5. **Interiors** (roadmap item 4 in `docs/maps3d.md`): Factory, Interchange, Labs, Labyrinth,
   Icebreaker and Reserve's bunkers are roof-only until then. The cache already has what this
   needs (all LOD levels, colliders including triggers, the culling and portal scenes). There
   is no NavMesh to use: scenes do not reference one.
6. **Housekeeping:** the published Customs and Streets builds predate the "optimize map size"
   commit (rebuild + `make publish`). `maps/3d/factory` has never been published.
   When every location is covered, remove the 2D maps (see `docs/maps3d.md`).

## When the game is needed again

Only for a game patch (or if something turns out to be missing from the cache): mount it, then
`make list-scenes`, `make cache` (about 40 minutes for everything), and `make cache-push`.
