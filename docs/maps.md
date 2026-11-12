# 2D map folders

A raid is drawn on a 3D map when its location has one (`maps/3d/`, see `docs/maps3d.md`). This
document is about the older 2D maps, still used for the locations without a 3D map: a calibrated
image per map. They are meant to go once every location has a 3D map.

Each 2D map is a folder under `maps/2d/` (`--maps-root` is `maps`) holding a `map.json` and its
layer images. The backend lists the folders of `maps/2d` and `maps/3d` at `/maps/index.json`; the
frontend picks the folder whose `ids` contain the raid's location id, the 3D one if there are both
(Settings has a switch for the 2D one).

Map images aren't committed (except `maps/2d/demo`). The ones in use, with their `map.json`, are
in B2: `scripts/assets.py pull maps/2d` (see the README, "Data files"). For a new map, bring your
own image, calibrate it, then `scripts/assets.py push maps/2d` and commit `assets.json`.

## `map.json`

```json
{
  "name": "Labs",
  "ids": ["laboratory", "laboratory_dark", "laboratory_event"],
  "calibration": {
    "points": [
      { "world": [-120.5, 310.2], "pixel": [412, 1880] },
      { "world": [260.0, -95.7], "pixel": [3120, 455] }
    ]
  },
  "layers": [
    { "image": "labs_0f.png", "maxY": -1.0 },
    { "image": "labs_1f.png", "maxY": 3.0 },
    { "image": "labs_2f.png" }
  ],
  "layerHysteresis": 0.5
}
```

| Field | Meaning |
|---|---|
| `name` | Display name. |
| `ids` | Game location ids this map is used for, compared case-insensitively. Event variants usually share the base map's folder. |
| `calibration.points` | Control points pairing a **world** position `[x, z]` (metres) with the **pixel** `[u, v]` where it appears in the image files, in the images' own pixel coordinates. |
| `layers` | Floor images, bottom to top. Each layer covers heights up to `maxY` (world y, metres); the top layer has no `maxY`. The local player's height picks the layer. |
| `layerHysteresis` | Metres beyond a layer's bounds before switching away from it (default 0.5), so stairs near a boundary don't flicker. |

All layers of a map share one calibration, so they must have the same pixel geometry. If an image set
doesn't, split it into separate folders.

### Calibration maths
- **2 points:** scale, rotation and translation, with the image's y axis pointing down while world z
  points north. Works for rotated images. Pick two points far apart.
- **3 or more points:** a least-squares affine fit. This also absorbs non-uniform scaling or a
  mirrored image, and averages out click inaccuracy. The points must not be collinear.

## Calibrating a new map

1. Create the folder with the images and a `map.json` with the right `ids` and `layers`. Use any two
   rough points for `calibration` to start with, for example
   `{"world": [0, 0], "pixel": [0, 0]}` and `{"world": [100, 100], "pixel": [100, -100]}`.
2. Start a raid on that map and open the frontend. Open **Settings** (cogwheel, bottom left) and press **Calibrate this map** (shown while a 2D map is on screen).
3. Stand somewhere recognisable in game (a building corner, a crossroads), then click that exact spot
   on the map image. The click is paired with your current world position.
4. Repeat at 2–4 places far apart, ideally spread over the whole map.
5. Copy the generated `"calibration"` block into `map.json` and reload the page. The maps index is
   re-read on every page load.

Calibrating from a frozen memory dump also works: the local player stands still, so take one point per
dump.

## Floors

Set each layer's `maxY` from heights read in game: the frontend shows the local player's position, and
the backend logs it every 5 s. A floor's `maxY` is roughly halfway between the floor levels.
