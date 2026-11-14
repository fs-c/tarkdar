# Handoff: every location as a 3D map

State on 2026-11-13 (Phase B started the same day: items 1 and 2 below). Background and pipeline: `docs/maps3d.md`.

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

1. ~~Huge backdrop objects~~ **done** (2026-11-13). All seven outdoor maps build in full on an
   18 GB machine (1.5 to 8 min each, at least 4 GB left free). What it took:
   - objects wider than 800 m are scenery and dropped (`hlod.Options.backdrop_size`): mountains,
     the city silhouette, the 12 km bridge. The build log names them;
   - objects more than 150 m outside the playable area are dropped too (`backdrop_margin`). The
     playable area is the heightmap terrain, or, on Ground Zero and Terminal, what the boxes of
     the `*_LevelBorders` scene enclose (`build.level_borders`, preset key `borders`), which also
     frames the camera there;
   - whoever samples surfaces gets large triangles cut to its area first
     (`geometry.clip_to_rect`): Lighthouse's sea floor is a plane of 700 m quads, which the
     ground map sampled whole (10 GB);
   - the sea floor is not ground for the ground map (`ground.SEA_FLOOR`): Terminal's whole port
     counted as one building standing on it.
2. **Tune each outdoor map**: Woods, Shoreline, Interchange, Reserve, Lighthouse, Ground Zero,
   Terminal are built into `maps/3d/<map>` (local, not published) and have been looked at top-down
   only. Left per map: look at it in the radar, `make_views.py` + reference + `make measure`,
   `make publish`, set `tuned`. Known so far:
   - rocks have a stand-in colour (`build.ROCK_COLOR`): cache v4 has no thumbnail of the rock
     shaders' albedo slots. The extractor is fixed (version 5) for the next extraction;
   - Terminal builds without the `PortCutscene_*` scenes (story cutscenes staged on the map);
   - combined scenery meshes that straddle the 150 m line stay (Shoreline: port buildings in the
     sea to the west), and so do the level-of-detail terrain slices of neighbouring locations;
   - Streets has level borders too but does not use them (unchanged build).
3. **Customs:** the game also loads `custom_city` and `custom_background`, which the hand list
   leaves out. Check whether they add anything worth showing.
4. **Variants:** Labs event, Factory event and Ground Zero start are separate presets for now.
   Decide per variant: an extra location id on the main map, or a map of its own.
   (`laboratory_dark` and `Sandbox_high` are already ids of Labs and Ground Zero.)
5. **Interiors**: the indoor maps (Factory, Labs, Labyrinth, Icebreaker) are done as a first
   version: built with everything kept and cut open at one floor in the viewer (`docs/maps3d.md`,
   "Indoor maps"). Built into `maps/3d/` locally, not published; checked with a synthetic Labs
   recording only, never with a real indoor raid. Left: the interiors on outdoor maps
   (Interchange's mall, Reserve's bunkers, Streets) with the same cut; the event variants
   (item 4). The culling scenes are scripts only: no rooms or portals to use.
6. **Housekeeping:** the published Customs and Streets builds predate the "optimize map size"
   commit (rebuild + `make publish`). `maps/3d/factory` has never been published.

## When the game is needed again

Only for a game patch (or if something turns out to be missing from the cache): mount it, then
`make list-scenes`, `make cache` (about 40 minutes for everything), and `make cache-push`.
