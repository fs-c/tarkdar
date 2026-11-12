"""Bake-time hidden-surface removal: which triangles can ever be seen?

A triangle is kept when, from at least one of a fixed set of view directions
(orthographic, i.e. a viewer far away), part of it is not behind other
geometry. The test is a point-sampled depth buffer:

    1. cover every triangle with sample points less than a pixel apart;
    2. per direction, keep the nearest depth per pixel over all *front-facing*
       samples (the viewer culls back faces, so they neither show nor hide);
    3. a triangle is visible if one of its front-facing samples is within
       `bias` of that nearest depth.

It errs on the side of keeping: a hole in the sampled depth buffer or a
missing occluder (other cells are not considered) can only make more
triangles visible, and `bias` keeps surfaces that lie just behind another one.
"""

from __future__ import annotations

import math

import numpy as np

CHUNK = 4_000_000   # samples projected at a time


def view_directions(elevations=(90, 65, 45, 25, 10, -15), per_ring=(1, 6, 8, 10, 12, 8)) -> np.ndarray:
    """Unit vectors pointing from the scene towards the viewer (Y up).

    Mostly the sky hemisphere (top-down and oblique map views). The ring below
    the horizon stands for a low camera looking slightly upwards, which sees
    the underside of canopies and overhangs."""
    out = []
    for ring, (elevation, count) in enumerate(zip(elevations, per_ring)):
        el = math.radians(elevation)
        for k in range(count):
            az = 2 * math.pi * (k + 0.5 * (ring % 2)) / count
            out.append((math.cos(el) * math.sin(az), math.sin(el), math.cos(el) * math.cos(az)))
    return np.array(out, dtype=np.float64)


def sample_triangles(positions: np.ndarray, indices: np.ndarray, spacing: float, max_steps: int = 2048):
    """Points covering every triangle, at most `spacing` apart.

    A triangle ABC (AB its longest edge) is covered by rows parallel to AB:
    p(s, t) = (1 - t) * (A + s * AB) + t * C, with steps chosen from the edge
    length and the height, so a long thin triangle gets a single row.

    Returns (points (S, 3) float32, triangle id per point (S,) int32)."""
    tri = positions[indices.reshape(-1, 3)].astype(np.float32)          # (T, 3, 3)
    lengths = np.linalg.norm(tri[:, [1, 2, 0]] - tri, axis=2)            # |AB|, |BC|, |CA|
    first = np.argmax(lengths, axis=1)                                   # longest edge starts at this corner
    rows = np.arange(len(tri))
    a = tri[rows, first]
    b = tri[rows, (first + 1) % 3]
    c = tri[rows, (first + 2) % 3]
    base = lengths[rows, first]
    area2 = np.linalg.norm(np.cross(b - a, c - a), axis=1)
    height = np.divide(area2, base, out=np.zeros_like(base), where=base > 0)
    ns = np.clip(np.ceil(base / spacing), 1, max_steps).astype(np.int64)
    nt = np.clip(np.ceil(height / spacing), 1, max_steps).astype(np.int64)
    per_tri = (ns + 1) * (nt + 1)
    owner = np.repeat(np.arange(len(tri), dtype=np.int32), per_tri)
    local = np.arange(int(per_tri.sum()), dtype=np.int64) - np.repeat(np.cumsum(per_tri) - per_tri, per_tri)
    cols = np.repeat(nt + 1, per_tri)
    # Cell-centred, so no sample lies on an edge (it would land on a neighbour's
    # pixels) and the gap across an edge shared by two triangles stays below one step.
    s = ((local // cols + 0.5) / np.repeat(ns + 1, per_tri)).astype(np.float32)[:, None]
    t = ((local % cols + 0.5) / np.repeat(nt + 1, per_tri)).astype(np.float32)[:, None]
    points = (1 - t) * (a[owner] + s * (b - a)[owner]) + t * c[owner]
    return points.astype(np.float32), owner


def face_normals(positions: np.ndarray, indices: np.ndarray) -> np.ndarray:
    tri = positions[indices.reshape(-1, 3)].astype(np.float64)
    return np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])


def above_ground(points: np.ndarray, ground_points: np.ndarray, pixel: float, clearance: float) -> np.ndarray:
    """Per point: is it more than `clearance` above the ground surface (or
    outside the area the ground samples cover)?"""
    lo = np.minimum(points[:, [0, 2]].min(axis=0), ground_points[:, [0, 2]].min(axis=0))

    def cells(pts):
        px = np.floor((pts[:, [0, 2]] - lo) / pixel).astype(np.int64)
        return px, px[:, 1] * width + px[:, 0]

    hi = np.maximum(points[:, [0, 2]].max(axis=0), ground_points[:, [0, 2]].max(axis=0))
    width, rows = (np.floor((hi - lo) / pixel).astype(np.int64) + 1).tolist()
    height = np.full(width * rows, -np.inf, dtype=np.float32)
    np.maximum.at(height, cells(ground_points)[1], ground_points[:, 1])
    return points[:, 1] > height[cells(points)[1]] + clearance


def visible_triangles(positions: np.ndarray, indices: np.ndarray, directions: np.ndarray, *,
                      pixel: float = 0.20, bias: float = 0.20,
                      occluders: tuple[np.ndarray, np.ndarray] | None = None,
                      ground_clearance: float = 0.25) -> np.ndarray:
    """Boolean mask over the triangles of (positions, indices).

    `occluders` is the ground: extra geometry (positions, indices) that hides
    but is not itself tested. For directions from above the horizon it is part
    of the depth buffer. A direction from below the horizon stands for a low
    camera looking up, which is still above the ground: there the ground is
    not rasterized (it would hide everything), but only samples more than
    `ground_clearance` above it can be seen.
    """
    triangle_count = len(indices) // 3
    visible = np.zeros(triangle_count, dtype=bool)
    if triangle_count == 0:
        return visible
    # Rows of samples run in arbitrary directions across the pixel grid: they
    # only reach every pixel when they are closer together than a pixel diagonal.
    spacing = pixel * 0.7
    points, owner = sample_triangles(positions, indices, spacing)
    normals = face_normals(positions, indices)
    occ = None
    if occluders is not None and len(occluders[1]):
        occ = (*sample_triangles(occluders[0], occluders[1], spacing), face_normals(*occluders))
    corners = np.asarray(positions, dtype=np.float64)
    exposed = above_ground(points, occ[0], pixel, ground_clearance) if occ is not None else None

    def chunks(pts, own, front):
        """(pixel key, depth, triangle id, position of the piece, selection within it) of the
        front-facing samples, in bounded pieces."""
        for start in range(0, len(pts), CHUNK):
            ids = own[start:start + CHUNK]
            sel = front[ids]
            if not sel.any():
                continue
            selected = pts[start:start + CHUNK][sel]
            # One axis at a time and in place: this loop is memory-bound.
            column, row = selected @ basis[0], selected @ basis[1]
            for axis, values in enumerate((column, row)):
                values -= lo[axis]
                values /= pixel
                np.floor(values, out=values)
            key = row.astype(key_type)
            key *= width
            key += column.astype(key_type)
            yield key, selected @ basis[2], ids[sel], start, sel

    for d in directions:
        # Orthonormal basis (u, v, d); depth = distance towards the viewer.
        helper = np.array([1.0, 0.0, 0.0]) if abs(d[1]) > 0.9 else np.array([0.0, 1.0, 0.0])
        u = np.cross(helper, d)
        u /= np.linalg.norm(u)
        basis = np.stack([u, np.cross(d, u), d]).astype(np.float32)
        use_occluders = occ is not None and d[1] > 0
        eligible = exposed if occ is not None and d[1] <= 0 else None
        extent = corners @ basis[:2].T.astype(np.float64)
        if use_occluders:
            extent = np.concatenate([extent, np.asarray(occluders[0], dtype=np.float64) @ basis[:2].T.astype(np.float64)])
        lo = (extent.min(axis=0) - pixel).astype(np.float32)
        width, rows = (np.ceil((extent.max(axis=0) - lo) / pixel).astype(np.int64) + 2).tolist()
        nearest = np.full(width * rows, -np.inf, dtype=np.float32)
        key_type = np.int32 if width * rows < 2**31 else np.int64

        front = normals @ d > 0
        # Projecting the samples is nearly all of the work: the projected samples are kept
        # for the test below instead of being projected a second time.
        projected = []
        for key, depth, ids, start, sel in chunks(points, owner, front):
            np.maximum.at(nearest, key, depth)
            if eligible is not None:
                keep = eligible[start:start + CHUNK][sel]
                key, depth, ids = key[keep], depth[keep], ids[keep]
            projected.append((key, depth, ids))
        if use_occluders:
            for key, depth, *_ in chunks(occ[0], occ[1], occ[2] @ d > 0):
                np.maximum.at(nearest, key, depth)
        for key, depth, ids in projected:
            visible[ids[depth >= nearest[key] - bias]] = True
    return visible
