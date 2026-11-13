"""Geometry processing for the build stage (numpy only, no game data)."""

from __future__ import annotations

import numpy as np

from .cache import Mesh

# Unity (left handed, Y up, +Z forward) -> three.js (right handed, Y up, -Z forward)
S = np.diag([1.0, 1.0, -1.0, 1.0])

AABB_CORNERS = np.array(
    [[sx, sy, sz] for sx in (0, 1) for sy in (0, 1) for sz in (0, 1)], dtype=np.float64
)

# Tarkov's serialized terrain heightmap values map to the heightmap's Y scale
# with a 32768 divisor. Calibrated against tree positions in custom_Terrain
# (median error ~1 cm).
TERRAIN_HEIGHT_DIVISOR = 32768.0


def to_three_matrix(unity_world: np.ndarray) -> np.ndarray:
    return S @ unity_world @ S


def world_aabb(lo, hi, m):
    corners = lo + (hi - lo) * AABB_CORNERS
    return (m[:3, :3] @ corners.T).T + m[:3, 3]


def compute_normals(positions: np.ndarray, indices: np.ndarray) -> np.ndarray:
    """Area-weighted smooth vertex normals for a triangle mesh."""
    tri = indices[: len(indices) // 3 * 3].reshape(-1, 3)   # ignore a trailing partial triangle
    if len(tri) == 0:
        return np.zeros_like(positions, dtype=np.float32)
    p0, p1, p2 = positions[tri[:, 0]], positions[tri[:, 1]], positions[tri[:, 2]]
    fn = np.cross(p1 - p0, p2 - p0)
    normals = np.zeros_like(positions, dtype=np.float64)
    flat = tri.reshape(-1)
    for k in range(3):
        normals[:, k] = np.bincount(flat, weights=np.repeat(fn[:, k], 3), minlength=len(positions))
    lens = np.linalg.norm(normals, axis=1, keepdims=True)
    lens[lens < 1e-9] = 1.0
    return (normals / lens).astype(np.float32)


def _parts(mesh: Mesh, index_count: int) -> np.ndarray:
    """Submesh ranges as (P, 2) [first index, index count], or one part for all.

    Parts are only kept when they are triangle lists that tile the whole index
    buffer in order; anything else (lines, gaps, overlaps) becomes one part.
    """
    whole = np.array([[0, index_count]], dtype=np.uint32)
    subs = mesh.submeshes or []
    if len(subs) < 2:
        return whole
    cursor = 0
    for first, count, topology in subs:
        if topology != 0 or first != cursor or count % 3:
            return whole
        cursor += count
    if cursor != index_count:
        return whole
    parts = np.array([[first, count] for first, count, _ in subs if count], dtype=np.uint32)
    return parts if len(parts) else whole


def mesh_to_three(mesh: Mesh):
    """Cached Unity mesh -> (positions, normals, indices, parts) in three.js space.

    `parts` are the submesh index ranges (one per material slot), see _parts.
    Returns None for meshes with no usable triangles.
    """
    vcount = mesh.vertex_count
    positions = np.array(mesh.positions, dtype=np.float32)
    positions[:, 2] *= -1.0

    normals = mesh.normals()
    if normals is not None:
        normals = np.array(normals, dtype=np.float32)
        normals[:, 2] *= -1.0
        lens = np.linalg.norm(normals, axis=1, keepdims=True)
        lens[lens == 0] = 1.0
        normals /= lens
        normals = normals.astype(np.float32)

    indices = np.asarray(mesh.indices, dtype=np.uint32)
    if indices.size == 0:
        return None
    filtered = False
    if int(indices.max()) >= vcount:
        bad = indices >= vcount
        if bad.all():
            return None
        indices = indices[~bad]
        filtered = True

    # Unity's front faces are clockwise; three.js expects counter-clockwise.
    # Combined with the Z reflection, every imported mesh needs its triangles
    # reversed to be front-facing. (Generated terrain is authored directly in
    # three.js space and is deliberately not flipped.)
    n3 = len(indices) // 3 * 3
    if n3:
        flipped = indices[:n3].reshape(-1, 3)[:, [0, 2, 1]].reshape(-1)
        indices = np.concatenate([flipped, indices[n3:]])
    if normals is None:
        normals = compute_normals(positions, indices)
    parts = np.array([[0, len(indices)]], dtype=np.uint32) if filtered else _parts(mesh, len(indices))
    return positions, normals, indices, parts


def terrain_mesh(heights: np.ndarray, scale, step: int):
    """Heightmap -> grid mesh in terrain-local three.js space.

    local_y = raw_height / 32768 * heightmap_scale.y
    """
    res = heights.shape[0]
    if res < 2:
        return None
    step = max(1, int(step))
    hs = np.asarray(heights, dtype=np.float32)[::step, ::step]
    rows, cols = hs.shape
    if rows < 2 or cols < 2:
        return None

    dx = float(scale[0]) * step
    dz = float(scale[2]) * step
    yy = hs * (float(scale[1]) / TERRAIN_HEIGHT_DIVISOR)

    xs = np.arange(cols, dtype=np.float32) * dx
    zs = np.arange(rows, dtype=np.float32) * dz
    xx, zz = np.meshgrid(xs, zs)

    positions = np.stack([xx, yy, zz], axis=-1).reshape(-1, 3).astype(np.float32)
    positions[:, 2] *= -1.0

    dhdx = np.gradient(yy, axis=1) / dx
    dhdz = np.gradient(yy, axis=0) / dz
    normals = np.stack([-dhdx, np.ones_like(yy), -dhdz], axis=-1)
    normals /= np.maximum(np.linalg.norm(normals, axis=-1, keepdims=True), 1e-6)
    normals[..., 2] *= -1.0
    normals = normals.reshape(-1, 3).astype(np.float32)

    # (v00, v10, v01) becomes CCW/up after the z reflection.
    r = np.arange(rows - 1, dtype=np.uint32)[:, None]
    c = np.arange(cols - 1, dtype=np.uint32)[None, :]
    v00 = (r * cols + c).reshape(-1)
    v10 = v00 + 1
    v01 = v00 + cols
    v11 = v01 + 1
    indices = np.stack([v00, v10, v01, v10, v11, v01], axis=-1).reshape(-1).astype(np.uint32)
    return positions, normals, indices, np.array([[0, len(indices)]], dtype=np.uint32)


def terrain_colors(splat_maps: list, layer_colors: list) -> np.ndarray | None:
    """Ground colour image of a terrain: its layers' mean colours blended by
    the splat (alpha) maps.

    splat_maps: (H, W, 4) uint8 arrays; channel c of map k is the weight of
    layer 4k + c. layer_colors: one (r, g, b) per layer (sRGB, 0..255) or None.
    Returns (H, W, 3) uint8, row 0 at the terrain's local z = 0, or None when
    there is nothing to blend.
    """
    total = None
    weight = None
    for k, splat in enumerate(splat_maps):
        w = np.asarray(splat, dtype=np.float32)
        for c in range(w.shape[2]):
            layer = 4 * k + c
            if layer >= len(layer_colors) or layer_colors[layer] is None:
                continue
            color = np.asarray(layer_colors[layer][:3], dtype=np.float32)
            if total is None:
                total = np.zeros((*w.shape[:2], 3), dtype=np.float32)
                weight = np.zeros(w.shape[:2], dtype=np.float32)
            total += w[..., c, None] * color
            weight += w[..., c]
    if total is None or not (weight > 0).any():
        return None
    covered = weight > 0
    out = np.empty_like(total)
    out[covered] = total[covered] / weight[covered, None]
    out[~covered] = total[covered].sum(axis=0) / weight[covered].sum()     # uncovered: the average ground
    return np.clip(np.rint(out), 0, 255).astype(np.uint8)


CLIP_SLACK = 8.0     # metres a triangle may reach beyond the rectangle before it is cut


def _clip_polygon_xz(polygon: np.ndarray, lo, hi) -> np.ndarray:
    """A convex polygon (N, 3) cut to the rectangle lo..hi in x and z (Sutherland-Hodgman)."""
    for axis, k in ((0, 0), (2, 1)):
        for bound, sign in ((lo[k], 1.0), (hi[k], -1.0)):
            if not len(polygon):
                return polygon
            d = (polygon[:, axis] - bound) * sign             # >= 0: inside
            out = []
            for p, q, dp, dq in zip(polygon, np.roll(polygon, -1, axis=0), d, np.roll(d, -1)):
                if dp >= 0:
                    out.append(p)
                if (dp >= 0) != (dq >= 0):
                    out.append(p + (q - p) * (dp / (dp - dq)))
            polygon = np.array(out).reshape(-1, 3)
    return polygon


def clip_to_rect(positions: np.ndarray, indices: np.ndarray, lo_xz, hi_xz, slack: float = CLIP_SLACK):
    """The triangles that touch the rectangle lo..hi (x, z), as (positions, indices) with only
    the vertices they use. Triangles reaching more than `slack` beyond it are cut to it: one
    quad of a sea floor plane is 700 m wide (Lighthouse), and whoever samples surfaces
    (visibility bake, ground map) samples all of what it is given."""
    lo_xz, hi_xz = np.asarray(lo_xz, dtype=np.float64), np.asarray(hi_xz, dtype=np.float64)
    tri = np.asarray(indices).reshape(-1, 3)
    if not len(tri):
        return positions[:0], tri.reshape(-1).astype(np.uint32)
    corners = positions[tri][:, :, [0, 2]]
    tmin, tmax = corners.min(axis=1), corners.max(axis=1)
    inside = ((tmax >= lo_xz) & (tmin <= hi_xz)).all(axis=1)
    large = inside & ((tmin < lo_xz - slack) | (tmax > hi_xz + slack)).any(axis=1)
    used, inverse = np.unique(tri[inside & ~large].reshape(-1), return_inverse=True)
    P, I, offset = [positions[used]], [inverse.astype(np.uint32)], len(used)
    for polygon in np.asarray(positions, dtype=np.float64)[tri[large]]:
        cut = _clip_polygon_xz(polygon, lo_xz, hi_xz)
        if len(cut) >= 3:
            fan = np.arange(1, len(cut) - 1, dtype=np.uint32)
            P.append(cut.astype(positions.dtype))
            I.append((np.stack([np.zeros_like(fan), fan, fan + 1], axis=1) + offset).reshape(-1).astype(np.uint32))
            offset += len(cut)
    return np.concatenate(P), np.concatenate(I)
