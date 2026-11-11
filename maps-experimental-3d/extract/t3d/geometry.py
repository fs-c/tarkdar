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
    tri = indices.reshape(-1, 3)
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


def mesh_to_three(mesh: Mesh):
    """Cached Unity mesh -> (positions, normals, indices) in three.js space.

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
    if int(indices.max()) >= vcount:
        bad = indices >= vcount
        if bad.all():
            return None
        indices = indices[~bad]

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
    return positions, normals, indices


def decimate(positions, normals, indices, ratio: float):
    """Reduce a mesh with meshoptimizer (fast-simplification)."""
    import fast_simplification as fs

    faces = indices.reshape(-1, 3).astype(np.int32)
    p, f = fs.simplify(positions.astype(np.float64), faces, target_reduction=float(ratio))
    p = p.astype(np.float32)
    f = f.astype(np.uint32).reshape(-1)
    return p, compute_normals(p, f), f


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
    return positions, normals, indices
