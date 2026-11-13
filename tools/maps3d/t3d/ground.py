"""Ground height map: for every square metre of the map, how high is the ground?

The viewer's plan style colours structure by its height above the ground (floor level, low
obstacle, building), so it needs the ground under and around everything, including under
roofs, where the baked map has no floor left. Three steps on a grid of `cell` metres:

    1. per cell, the lowest and the highest up-facing surface (roofs, floors, roads, terrain);
    2. ground seeds: heightmap terrain is ground by definition; elsewhere a progressive
       morphological filter (as used to get terrain out of LiDAR surfaces) removes everything
       that stands out of its surroundings by more than a threshold growing with the window;
    3. growth: a surface that continues the ground without a step (a bridge deck, a ramp, a
       loading dock with a ramp) is ground as well. What is left (under buildings, under cars)
       is filled in from the ground around it.

The result is single-valued: under a bridge the ground is the deck.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .geometry import clip_to_rect
from .visibility import face_normals, sample_triangles

UP = 0.7            # normal.y of a surface one can stand on (about 45 degrees)
FILTER_RADII = (1, 2, 4, 8, 16, 32, 64, 128)   # metres
FILTER_BASE = 0.3   # metres a ground cell may stand out of the smallest window
FILTER_SLOPE = 0.3  # ... plus this per metre of window growth
FILTER_MAX = 3.0    # ... but never more than this
STEP = 0.35         # metres per cell that still count as continuous ground (about 19 degrees)
TALL = 2.0          # metres above the ground from which something is taller than a person
WIDE = 2            # cells around a cell that must all be tall for it to be part of a building (5 m across)
MARGIN = 8          # cells around the surfaces
SEA_FLOOR = 2000.0  # metres: a wider plane called terrain is the sea floor (Terminal: 5.9 km), not ground
AROUND_FOCUS = 150  # metres around the playable area that are covered


@dataclass
class GroundMap:
    origin: tuple[float, float]   # world x, z of the corner of cell (0, 0)
    cell: float
    heights: np.ndarray           # (rows = z, columns = x) float32: ground height at cell centres
    building: np.ndarray          # same shape, bool: under something tall and wide (not a wall, pole or vehicle)


def _window_min(a: np.ndarray, radius: int, axis: int) -> np.ndarray:
    """Minimum over [-radius, radius] along one axis (edges: the window is clipped)."""
    length = 2 * radius + 1
    a = np.moveaxis(a, axis, 0)
    pad = np.full((radius,) + a.shape[1:], np.inf, dtype=a.dtype)
    m = np.concatenate([pad, a, pad])            # m[i] = a[i - radius]
    span = 1
    while span * 2 <= length:                    # m[i] = min a[i - radius .. i - radius + span - 1]
        m = np.minimum(m[:-span], m[span:])
        span *= 2
    out = np.minimum(m[: len(a)], m[length - span : length - span + len(a)])
    return np.moveaxis(out, 0, axis)


def _erode(a: np.ndarray, radius: int) -> np.ndarray:
    return _window_min(_window_min(a, radius, 0), radius, 1)


def _open(a: np.ndarray, radius: int) -> np.ndarray:
    """Morphological opening with a square window; +inf marks empty cells."""
    eroded = _erode(a, radius)
    return -_erode(-eroded, radius)


def _fill(values: np.ndarray, known: np.ndarray) -> np.ndarray:
    """Fills unknown cells from the known ones around them (pull-push over an image pyramid)."""
    if known.all() or values.size <= 1:
        return np.where(known, values, 0.0).astype(np.float32) if not known.any() else values
    rows, cols = values.shape
    pr, pc = rows + rows % 2, cols + cols % 2
    v = np.zeros((pr, pc), dtype=np.float64)
    w = np.zeros((pr, pc), dtype=np.float64)
    v[:rows, :cols] = np.where(known, values, 0.0)
    w[:rows, :cols] = known
    weight = w.reshape(pr // 2, 2, pc // 2, 2).sum(axis=(1, 3))
    total = v.reshape(pr // 2, 2, pc // 2, 2).sum(axis=(1, 3))
    coarse_known = weight > 0
    coarse = _fill(np.divide(total, weight, out=np.zeros_like(total), where=coarse_known), coarse_known)
    # Bilinear upsampling of the coarse level, so filled areas have no blocks.
    cr, cc = coarse.shape
    y = np.clip((np.arange(pr) - 0.5) / 2, 0, cr - 1)
    x = np.clip((np.arange(pc) - 0.5) / 2, 0, cc - 1)
    y0, x0 = np.floor(y).astype(int), np.floor(x).astype(int)
    y1, x1 = np.minimum(y0 + 1, cr - 1), np.minimum(x0 + 1, cc - 1)
    fy, fx = (y - y0)[:, None], (x - x0)[None, :]
    up = ((coarse[y0][:, x0] * (1 - fx) + coarse[y0][:, x1] * fx) * (1 - fy)
          + (coarse[y1][:, x0] * (1 - fx) + coarse[y1][:, x1] * fx) * fy)
    return np.where(known, values, up[:rows, :cols])


def _grow(height: np.ndarray, accepted: np.ndarray, candidates: list[np.ndarray], step: float) -> None:
    """Accepts candidate surfaces that continue accepted ground without a step (in place)."""
    rows, cols = height.shape
    h = height.reshape(-1)
    acc = accepted.reshape(-1)
    cands = [c.reshape(-1) for c in candidates]
    frontier = np.flatnonzero(acc)
    while len(frontier):
        fresh = []
        for d_row, d_col in ((0, 1), (0, -1), (1, 0), (-1, 0)):
            r, c = frontier // cols + d_row, frontier % cols + d_col
            inside = (r >= 0) & (r < rows) & (c >= 0) & (c < cols)
            source, target = frontier[inside], (r * cols + c)[inside]
            for cand in cands:
                # Onto unknown cells, and up from known ground onto what spans it (a bridge over a river).
                reach = np.abs(cand[target] - h[source]) <= step                 # NaN compares false
                ok = reach & (~acc[target] | (cand[target] > h[target] + 0.05))
                t, s = target[ok], source[ok]
                # Several sources may reach a target: any of them will do.
                t, first = np.unique(t, return_index=True)
                h[t] = cand[t]
                acc[t] = True
                fresh.append(t)
        frontier = np.unique(np.concatenate(fresh)) if fresh else np.zeros(0, dtype=np.int64)


def _up_samples(positions: np.ndarray, indices: np.ndarray, spacing: float) -> np.ndarray:
    normals = face_normals(positions, indices)
    length = np.linalg.norm(normals, axis=1)
    up = normals[:, 1] > UP * np.maximum(length, 1e-12)
    if not up.any():
        return np.zeros((0, 3), dtype=np.float32)
    points, _ = sample_triangles(positions, indices.reshape(-1, 3)[up].reshape(-1), spacing)
    return points


def height_map(surfaces: list[tuple[np.ndarray, np.ndarray, bool]], bounds_xz, cell: float = 1.0,
               debug: dict | None = None) -> GroundMap:
    """`surfaces`: world-space (positions (V, 3), indices, is heightmap terrain) triples.
    `bounds_xz`: ((x0, z0), (x1, z1)), the area to cover."""
    (x0, z0), (x1, z1) = bounds_xz
    x0, z0 = np.floor(x0 / cell) * cell - MARGIN * cell, np.floor(z0 / cell) * cell - MARGIN * cell
    cols = int(np.ceil((x1 - x0) / cell)) + MARGIN
    rows = int(np.ceil((z1 - z0) / cell)) + MARGIN
    low = np.full(rows * cols, np.inf, dtype=np.float32)
    top = np.full(rows * cols, -np.inf, dtype=np.float32)
    terrain = np.full(rows * cols, -np.inf, dtype=np.float32)
    for positions, indices, is_terrain in surfaces:
        # Only what lies over the grid (a sea floor plane has triangles of 700 m).
        positions, indices = clip_to_rect(positions, indices, (x0, z0), (x0 + cols * cell, z0 + rows * cell), 64.0)
        tri = indices.reshape(-1, 3)
        for start in range(0, len(tri), 400_000):
            points = _up_samples(positions, tri[start:start + 400_000].reshape(-1), cell * 0.5)
            cx = np.floor((points[:, 0] - x0) / cell).astype(np.int64)
            cz = np.floor((points[:, 2] - z0) / cell).astype(np.int64)
            inside = (cx >= 0) & (cx < cols) & (cz >= 0) & (cz < rows)
            key, y = (cz * cols + cx)[inside], points[inside, 1]
            if is_terrain:
                np.maximum.at(terrain, key, y)
            else:
                np.minimum.at(low, key, y)
                np.maximum.at(top, key, y)
    low, top, terrain = (a.reshape(rows, cols) for a in (low, top, terrain))
    trusted = np.isfinite(terrain)
    surface = np.where(trusted, terrain, low)
    filled = np.isfinite(surface)

    ground = filled.copy()
    current = surface
    previous = 0
    for radius_m in FILTER_RADII:
        radius = max(1, round(radius_m / cell))
        opened = _open(current, radius)
        limit = min(FILTER_BASE + FILTER_SLOPE * (radius - previous) * cell, FILTER_MAX)
        with np.errstate(invalid="ignore"):
            ground &= ~((current - opened) > limit)
        current, previous = opened, radius
    ground |= trusted

    height = _fill(np.where(ground, surface, 0.0), ground).astype(np.float32)
    accepted = ground.copy()
    nan = np.float32(np.nan)
    _grow(height, accepted, [np.where(np.isfinite(top), top, nan), np.where(np.isfinite(low), low, nan)], STEP * cell)
    height = _fill(height, accepted).astype(np.float32)
    # Buildings: tall over a width no wall, pole, container or bus has. One cell more than that,
    # so the mask covers their edges whatever the sampling.
    tall = np.where(np.isfinite(top) & (top - height > TALL), 1.0, 0.0)
    building = _erode(-_erode(tall, WIDE), WIDE + 1) < 0
    if debug is not None:
        debug.update(low=low, top=top, trusted=trusted, seeds=ground, accepted=accepted)
    return GroundMap((float(x0), float(z0)), cell, height, building)


def of_dataset(ds, focus_bounds, cell: float = 1.0) -> GroundMap | None:
    """Ground map of a baked dataset: structure, glass and terrain in and around the playable
    area (`focus_bounds`: (min xyz, max xyz)). None if there is no structure."""
    surfaces = []
    lo, hi = np.full(2, np.inf), np.full(2, -np.inf)
    for inst in ds.instances:
        category = inst.slots[0].category
        if category not in ("structure", "glass", "terrain"):
            continue
        geom = ds.geoms[inst.geom]
        positions = geom.positions.astype(np.float64) @ inst.matrix[:3, :3].T + inst.matrix[:3, 3]
        if category == "terrain" and geom.kind != "terrain" and np.ptp(positions[:, [0, 2]], axis=0).max() > SEA_FLOOR:
            continue      # with it as the lowest surface, a whole port is "a building" on the sea floor
        # Only a heightmap terrain is ground by definition: a plane classified as terrain by
        # its name may lie anywhere.
        surfaces.append((positions, geom.indices.astype(np.uint32), geom.kind == "terrain"))
        if category != "terrain":
            lo = np.minimum(lo, positions[:, [0, 2]].min(axis=0))
            hi = np.maximum(hi, positions[:, [0, 2]].max(axis=0))
    if not np.isfinite(lo).all():
        return None
    focus_lo, focus_hi = (np.asarray(b, dtype=np.float64)[[0, 2]] for b in focus_bounds)
    lo, hi = np.maximum(lo, focus_lo - AROUND_FOCUS), np.minimum(hi, focus_hi + AROUND_FOCUS)
    if (hi <= lo).any():
        return None
    return height_map(surfaces, (lo, hi), cell)
