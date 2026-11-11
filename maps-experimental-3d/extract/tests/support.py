"""Shared helpers: import path and a tiny synthetic cache."""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from t3d import cache  # noqa: E402

REAL_CACHE = cache.DEFAULT_ROOT
HAS_REAL_CACHE = (REAL_CACHE / "manifest.json").exists()

IDENTITY = np.eye(4)


def translation(x, y, z):
    m = np.eye(4)
    m[:3, 3] = [x, y, z]
    return m


def quad_mesh(size=1.0, submeshes=None, z=0.0) -> cache.Mesh:
    """A quad in the XY plane (Unity space, clockwise = front facing)."""
    positions = np.array([[0, 0, z], [0, size, z], [size, size, z], [size, 0, z]], dtype=np.float32)
    indices = np.array([0, 1, 2, 0, 2, 3], dtype=np.uint32)
    submeshes = submeshes or [[0, 6, 0]]
    return cache.Mesh(cache.mesh_hash(positions, indices, submeshes, None, None), positions, indices,
                      submeshes, None, None)


def write_cache(root: Path, renderers: list[dict], *, meshes: list[cache.Mesh], materials=None,
                lod_groups=None, lod_members=None, terrains=None, terrain_arrays=None,
                scene_path="Assets/Content/Locations/Test/test_scene.unity", map_name="test"):
    """Write a one-scene cache. Each renderer: {mesh, matrix, materials?, path?,
    enabled?, active?} where `mesh` indexes `meshes` and `materials` index
    `materials`."""
    store = cache.MeshStore(root)
    for m in meshes:
        store.add(m)
    store.flush()

    strings = []
    mat_refs, mat_start, mat_count = [], [], []
    for r in renderers:
        strings.append(r.get("path", f"root/{len(strings)}"))
        mat_start.append(len(mat_refs))
        mat_count.append(len(r.get("materials", [])))
        mat_refs.extend(r.get("materials", []))
    n = len(renderers)
    arrays = {
        "r_enabled": np.array([r.get("enabled", True) for r in renderers], dtype=np.uint8),
        "r_active": np.array([r.get("active", True) for r in renderers], dtype=np.uint8),
        "r_has_transform": np.ones(n, dtype=np.uint8),
        "r_mesh": np.array([r["mesh"] for r in renderers], dtype=np.int32),
        "r_matrix": np.array([r.get("matrix", IDENTITY) for r in renderers], dtype=np.float64).reshape(n, 4, 4),
        "r_go_path": np.arange(n, dtype=np.int32),
        "r_mat_start": np.array(mat_start, dtype=np.int32),
        "r_mat_count": np.array(mat_count, dtype=np.int16),
        "r_material_ref": np.array(mat_refs, dtype=np.int32),
        "lod_members": np.array(lod_members or [], dtype=np.int32).reshape(-1, 3),
    }
    arrays.update(terrain_arrays or {})
    meta = {
        "level": "level1",
        "scenePath": scene_path,
        "meshRefs": [{"hash": m.hash, "name": getattr(m, "name", f"mesh{i}"), "status": "ok"}
                     for i, m in enumerate(meshes)],
        "strings": strings,
        "lodGroups": lod_groups or [],
        "materials": materials or [],
        "textures": [{"name": "albedo", "mean": [100.0, 150.0, 200.0, 255.0]}],
        "terrains": terrains or [],
    }
    key = cache.scene_key(scene_path)
    cache.write_scene(root, key, meta, arrays)
    cache.save_manifest({
        "format": cache.CACHE_FORMAT,
        "scenes": {key: {"path": scene_path}},
        "maps": {map_name: {"label": "Test", "tag": "TEST", "indoorOptional": True, "scenes": [key]}},
    }, root)
    return key


def named(mesh: cache.Mesh, name: str) -> cache.Mesh:
    mesh.name = name
    return mesh
