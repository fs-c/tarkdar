"""The overview profile: merge placed renderers into spatial cells, simplify
each cell and drop what can never be seen.

    Dataset (instances of shared meshes)  ->  Dataset (one mesh per cell and
    category, in world space, simplified to an absolute error bound)

Why per cell instead of per mesh: a merged cell is one draw call that can be
frustum-culled, and the simplifier sees the touching modular pieces as one
surface. Small detached props disappear by themselves once they are smaller
than the error bound (meshoptimizer's "prune"), so there is no size cutoff.

Categories that are not merged (terrain, water) pass through unchanged.
"""

from __future__ import annotations

import os
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor, wait, FIRST_COMPLETED
from dataclasses import dataclass, replace

import numpy as np

from . import dataset, geometry, visibility

# Vertex colours (sRGB) for slots without a material colour: the viewer's
# category colours.
CATEGORY_COLOR = {
    "structure": (185, 193, 200),
    "terrain": (125, 138, 111),
    "foliage": (95, 114, 77),
    "water": (90, 127, 144),
    "glass": (159, 196, 216),
    "road": (150, 150, 150),
}
DEFAULT_COLOR = (185, 193, 200)
GROUND_DESATURATION = 0.4     # 1 - the default groundSaturation in web/src/map3d/settings.ts


@dataclass
class Options:
    cell_size: float = 128.0          # metres, grid in the XZ plane
    error: float = 0.10               # metres, absolute simplification error bound
    merge: tuple = ("structure", "glass", "road")
    # Kept as authored: a road lies centimetres above the terrain, and moving its vertices by the
    # simplification error would sink parts of it. Only what one can stand on is road: the same
    # shader is used for rubble.
    surfaces: tuple = ("road",)
    surface_up: float = 0.7           # normal.y from which a triangle is a surface
    drop: tuple = ("shadow", "decal", "background", "foliage")
    hsr: bool = True                  # remove triangles that are never visible from outside
    hsr_categories: tuple = ("structure",)
    hsr_pixel: float = 0.20           # metres, sampling step of the visibility bake
    hsr_bias: float = 0.20            # metres, depth tolerance (surfaces this close behind another stay)
    occluder_margin: float = 16.0     # metres of terrain around a cell used as occluder
    workers: int = 0                  # 0 = one per CPU
    tree_markers: bool = True         # one simple marker per tree instead of foliage geometry


def cell_of(center, cell_size: float) -> tuple[int, int]:
    return int(np.floor(center[0] / cell_size)), int(np.floor(center[2] / cell_size))


def instance_world(geom: dataset.Geom, matrix: np.ndarray, ranges: list[tuple[int, int]]):
    """World-space (positions float64, indices, used) of the given index ranges
    of one placed mesh. Only the vertices those ranges use are returned;
    `used` are their indices in the mesh."""
    idx = np.concatenate([geom.indices[first:first + count] for first, count in ranges])
    used, inverse = np.unique(idx, return_inverse=True)
    linear = matrix[:3, :3]
    positions = geom.positions[used].astype(np.float64) @ linear.T + matrix[:3, 3]
    tri = inverse.reshape(-1, 3)
    if np.linalg.det(linear) < 0:
        tri = tri[:, [0, 2, 1]]          # a mirroring transform flips the winding
    return positions, tri.reshape(-1).astype(np.uint32), used


def simplify(positions: np.ndarray, indices: np.ndarray, error: float) -> np.ndarray:
    """Error-bounded simplification. Returns new indices into `positions`
    (a subset of the original vertices: nothing is moved)."""
    import meshoptimizer as mo

    if error <= 0 or len(indices) < 3:
        return indices
    src = np.ascontiguousarray(indices, dtype=np.uint32)
    dest = np.zeros_like(src)
    count = mo.simplify(dest, src, np.ascontiguousarray(positions, dtype=np.float32), target_index_count=0,
                        target_error=float(error), options=mo.SIMPLIFY_ERROR_ABSOLUTE | mo.SIMPLIFY_PRUNE)
    return dest[:count]


def compact(indices: np.ndarray, *vertex_arrays):
    """Drop unreferenced vertices."""
    used, inverse = np.unique(indices, return_inverse=True)
    return inverse.astype(np.uint32), tuple(a[used] for a in vertex_arrays)


def weld(indices: np.ndarray, positions: np.ndarray, colors: np.ndarray):
    """Share vertices with the same float32 position and colour. Cell meshes
    are flat shaded, so normals do not split vertices.
    Returns (indices, positions, colors)."""
    record = np.dtype([("p", "<f4", 3), ("c", "u1", 4)])
    records = np.empty(len(positions), dtype=record)
    records["p"] = positions
    records["c"] = colors
    keys = records.view(np.dtype((np.void, record.itemsize)))
    _, first, inverse = np.unique(keys, return_index=True, return_inverse=True)
    return inverse[indices].astype(np.uint32), positions[first], colors[first]


def drop_degenerate(indices: np.ndarray) -> np.ndarray:
    """Remove triangles that use a vertex twice (welding can create them)."""
    tri = indices.reshape(-1, 3)
    keep = (tri[:, 0] != tri[:, 1]) & (tri[:, 1] != tri[:, 2]) & (tri[:, 0] != tri[:, 2])
    return tri[keep].reshape(-1)


TREE_MIN_HEIGHT = 3.0     # metres: smaller foliage is bushes and grass
TREE_MAX_WIDTH = 40.0     # wider "foliage" is a batch of many plants, not one tree
TREE_MERGE = 2.0          # trunk, crown and LOD parts of one tree fall into one grid square


def tree_positions(boxes: list[tuple]) -> list[tuple[float, float, float, float]]:
    """(x, base y, z, height) per tree from the world boxes of foliage renderers."""
    best: dict[tuple, tuple] = {}
    for lo, hi in boxes:
        size = hi - lo
        if size[1] < TREE_MIN_HEIGHT or max(size[0], size[2]) > TREE_MAX_WIDTH:
            continue
        x, z = (lo[0] + hi[0]) / 2, (lo[2] + hi[2]) / 2
        key = (int(np.floor(x / TREE_MERGE)), int(np.floor(z / TREE_MERGE)))
        if key not in best or size[1] > best[key][3]:
            best[key] = (float(x), float(lo[1]), float(z), float(size[1]))
    return [best[k] for k in sorted(best)]


def tree_marker(sides: int = 6) -> dataset.Geom:
    """Unit tree: a thin trunk and a cone, 1 high with radius 1 (scaled per tree)."""
    angles = 2 * np.pi * np.arange(sides) / sides
    ring = np.stack([np.sin(angles), np.zeros(sides), np.cos(angles)], axis=1)
    crown = np.concatenate([ring + [0, 0.3, 0], [[0, 1.0, 0]]])
    trunk = np.concatenate([ring * 0.18, ring * 0.18 + [0, 0.3, 0]])
    positions = np.concatenate([crown, trunk]).astype(np.float32)
    tris = []
    for k in range(sides):
        n = (k + 1) % sides
        tris.append((k, n, sides))                                     # crown side
        tris.append((sides + 1 + k, sides + 1 + n, 2 * sides + 1 + n))  # trunk side
        tris.append((sides + 1 + k, 2 * sides + 1 + n, 2 * sides + 1 + k))
    for k in range(1, sides - 1):
        tris.append((0, k + 1, k))                                     # crown underside
    indices = np.array(tris, dtype=np.uint32).reshape(-1)
    colors = np.empty((len(positions), 4), dtype=np.uint8)
    colors[: sides + 1] = (96, 134, 88, 255)
    colors[sides + 1:] = (112, 94, 76, 255)
    return dataset.Geom("tree_marker", "mesh", positions, np.zeros_like(positions), indices,
                        np.array([[0, len(indices)]], dtype=np.uint32), colors, flat=True)


def _process_cell(job):
    """Worker: simplify one merged cell mesh, remove what is never visible, weld.

    Runs in a separate process; everything in `job` and in the result is plain
    numpy. Returns None when nothing is left."""
    positions, colors, indices, opt, do_hsr, occluder, surface = job
    stats = {"in": len(indices) // 3}
    if surface:
        normals = visibility.face_normals(positions, indices)
        up = normals[:, 1] > opt.surface_up * np.maximum(np.linalg.norm(normals, axis=1), 1e-12)
        indices = indices.reshape(-1, 3)[up].reshape(-1)
    else:
        indices = simplify(positions, indices, opt.error)
    stats["simplified"] = len(indices) // 3
    if do_hsr and len(indices):
        seen = visibility.visible_triangles(positions, indices, visibility.view_directions(),
                                            pixel=opt.hsr_pixel, bias=opt.hsr_bias, occluders=occluder)
        indices = indices.reshape(-1, 3)[seen].reshape(-1)
    if len(indices) >= 3:
        indices, (positions, colors) = compact(indices, positions, colors)
        indices, positions, colors = weld(indices, positions, colors)
        indices = drop_degenerate(indices)
    stats["out"] = len(indices) // 3
    if len(indices) < 3:
        return None, stats
    return (indices, positions, colors), stats


def _terrain_triangles(ds: dataset.Dataset, instances: list) -> tuple[np.ndarray, np.ndarray]:
    """World-space (positions float64, indices) of all terrain instances."""
    P, I = [], []
    offset = 0
    for inst in instances:
        if inst.slots[0].category != "terrain":
            continue
        geom = ds.geoms[inst.geom]
        P.append(geom.positions.astype(np.float64) @ inst.matrix[:3, :3].T + inst.matrix[:3, 3])
        I.append(geom.indices.astype(np.uint32) + offset)
        offset += len(geom.positions)
    if not P:
        return np.zeros((0, 3)), np.zeros(0, dtype=np.uint32)
    return np.concatenate(P), np.concatenate(I)


def _occluder_for(terrain, lo, hi, margin: float, origin):
    """Terrain triangles around a cell's bounds, in cell-local float32."""
    positions, indices = terrain
    if not len(indices):
        return None
    tri = indices.reshape(-1, 3)
    corners = positions[tri]
    tmin, tmax = corners.min(axis=1), corners.max(axis=1)
    inside = ((tmax[:, 0] >= lo[0] - margin) & (tmin[:, 0] <= hi[0] + margin) &
              (tmax[:, 2] >= lo[2] - margin) & (tmin[:, 2] <= hi[2] + margin))
    if not inside.any():
        return None
    idx, (pos,) = compact(tri[inside].reshape(-1), positions)
    return (pos - origin).astype(np.float32), idx


def bake(ds: dataset.Dataset, opt: Options, log=print) -> dataset.Dataset:
    merge, drop = set(opt.merge), set(opt.drop)
    bounds = [g.bounds() for g in ds.geoms]

    # (cell, category) -> [(instance, [(slot, (first, count)), ...]), ...]
    buckets: dict[tuple, list] = defaultdict(list)
    passthrough: list[dataset.Instance] = []
    foliage_boxes: list[tuple] = []
    dropped = 0
    for inst in ds.instances:
        geom = ds.geoms[inst.geom]
        by_category: dict[str, list] = defaultdict(list)
        for slot, (first, count) in zip(inst.slots, geom.parts.tolist()):
            by_category[slot.category].append((slot, (first, count)))
        if not any(c in merge for c in by_category):
            if all(c in drop for c in by_category):
                dropped += 1
                if opt.tree_markers and set(by_category) == {"foliage"}:
                    wa = geometry.world_aabb(*bounds[inst.geom], inst.matrix)
                    foliage_boxes.append((wa.min(axis=0), wa.max(axis=0)))
            else:
                passthrough.append(inst)     # terrain, water: kept as instances (noise parts included)
            continue
        wa = geometry.world_aabb(*bounds[inst.geom], inst.matrix)
        cell = cell_of((wa.min(axis=0) + wa.max(axis=0)) / 2, opt.cell_size)
        for category, parts in by_category.items():
            if category in merge:
                buckets[(cell, category)].append((inst, parts))

    terrain = _terrain_triangles(ds, passthrough) if opt.hsr else None

    def job_for(category, items):
        """Merge one bucket into cell-local arrays (the simplifier and the
        visibility bake work in float32; world coordinates would lose precision)."""
        P, C, I = [], [], []
        offset = 0
        fallback = CATEGORY_COLOR.get(category, DEFAULT_COLOR)
        for inst, parts in items:
            geom = ds.geoms[inst.geom]
            # One colour per part; vertices shared between parts take the last one.
            colors = np.empty((len(geom.positions), 4), dtype=np.uint8)
            colors[:] = (*fallback, 255)
            for slot, (first, count) in parts:
                if slot.color[3]:
                    colors[geom.indices[first:first + count]] = slot.color
            p, idx, used = instance_world(geom, inst.matrix, [r for _, r in parts])
            P.append(p)
            C.append(colors[used])
            I.append(idx + offset)
            offset += len(p)
        positions = np.concatenate(P)
        lo, hi = positions.min(axis=0), positions.max(axis=0)
        do_hsr = opt.hsr and category in opt.hsr_categories
        occluder = _occluder_for(terrain, lo, hi, opt.occluder_margin, lo) if do_hsr else None
        return lo, ((positions - lo).astype(np.float32), np.concatenate(C), np.concatenate(I), opt, do_hsr,
                    occluder, category in opt.surfaces)

    # Cells are independent: process them in parallel, a few in flight at a time
    # (a merged cell is up to a few hundred MB before simplification).
    keys = sorted(buckets)
    results: dict[tuple, tuple] = {}      # bucket key -> (mesh or None, stats)
    origins: dict[tuple, np.ndarray] = {}
    totals = defaultdict(int)
    workers = opt.workers or os.cpu_count() or 1
    # One thread per worker: numpy's BLAS would otherwise start a thread per
    # core in every worker and the machine thrashes. Workers inherit this.
    for var in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS"):
        os.environ[var] = "1"
    with ProcessPoolExecutor(max_workers=workers) as pool:
        pending = {}
        for key in keys:
            origins[key], job = job_for(key[1], buckets[key])
            pending[pool.submit(_process_cell, job)] = key
            del job
            while len(pending) >= workers + 2:
                done, _ = wait(pending, return_when=FIRST_COMPLETED)
                for future in done:
                    results[pending.pop(future)] = future.result()
        for future, key in pending.items():
            results[key] = future.result()

    out_geoms: list[dataset.Geom] = []
    out_instances: list[dataset.Instance] = []
    cells = sorted({cell for cell, _ in buckets})
    scene_of = {cell: i for i, cell in enumerate(cells)}
    scenes = [{"level": f"cell {x},{z}", "path": f"cells/cell_{x}_{z}"} for x, z in cells]
    vertices = 0
    for key in keys:
        mesh, stats = results[key]
        for name, value in stats.items():
            totals[name] += value
        if mesh is None:
            continue
        cell, category = key
        origin = origins[key]
        indices, positions, colors = mesh
        vertices += len(positions)
        # Back to world space. float32 is exact enough here: the map is ~2 km across.
        world = (positions.astype(np.float64) + origin).astype(np.float32)
        out_instances.append(dataset.Instance(len(out_geoms), np.eye(4), scene_of[cell], [dataset.Slot(category)], -1))
        out_geoms.append(dataset.Geom(f"cell_{cell[0]}_{cell[1]}_{category}", "mesh", world,
                                      np.zeros((len(world), 3), dtype=np.float32), indices,
                                      np.array([[0, len(indices)]], dtype=np.uint32), colors, flat=True))
    cell_meshes = len(out_geoms)

    # Terrain without a ground image (backdrop meshes around the map) takes the
    # average ground colour, so it does not stand out against the real terrain.
    grounds = [g.texture.reshape(-1, 3).mean(axis=0) for g in (ds.geoms[i.geom] for i in passthrough)
               if g.texture is not None]
    average_ground = None
    if grounds:
        mean = np.mean(grounds, axis=0)
        # The renderer mutes ground images (settings.ts groundSaturation); match its default here.
        mean = mean + (mean @ np.array([0.2126, 0.7152, 0.0722]) - mean) * GROUND_DESATURATION
        average_ground = tuple(int(v) for v in np.rint(mean))

    # Unmerged instances keep their meshes and scenes (appended after the cells).
    geom_map: dict[int, int] = {}
    scene_map: dict[int, int] = {}
    for inst in passthrough:
        if inst.geom not in geom_map:
            geom_map[inst.geom] = len(out_geoms)
            geom = ds.geoms[inst.geom]
            colors = np.empty((len(geom.positions), 4), dtype=np.uint8)
            # A draped colour image is multiplied with the vertex colour: white.
            category = inst.slots[0].category
            if geom.texture is not None:
                base = (255, 255, 255)
            elif category == "terrain" and average_ground is not None:
                base = average_ground
            else:
                base = CATEGORY_COLOR.get(category, DEFAULT_COLOR)
            colors[:] = (*base, 255)
            out_geoms.append(replace(geom, colors=colors))
        if inst.scene not in scene_map:
            scene_map[inst.scene] = len(scenes)
            scenes.append(ds.scenes[inst.scene])
        out_instances.append(dataset.Instance(geom_map[inst.geom], inst.matrix, scene_map[inst.scene],
                                              inst.slots, inst.path))

    trees = tree_positions(foliage_boxes) if opt.tree_markers else []
    if trees:
        marker = len(out_geoms)
        out_geoms.append(tree_marker())
        scenes.append({"level": "trees", "path": "markers/trees"})
        for x, y, z, height in trees:
            radius = float(np.clip(0.16 * height, 0.6, 2.0))
            m = np.diag([radius, height, radius, 1.0])
            m[:3, 3] = [x, y, z]
            out_instances.append(dataset.Instance(marker, m, len(scenes) - 1, [dataset.Slot("foliage")], -1))

    log(f"  cells: {len(cells)} of {opt.cell_size:g} m, error {opt.error * 100:g} cm: {totals['in']:,} triangles "
        f"-> {totals['simplified']:,} simplified -> {totals['out']:,} visible ({vertices:,} vertices) in "
        f"{cell_meshes:,} cell meshes; {len(passthrough):,} instances kept as they are, {dropped:,} dropped, "
        f"{len(trees):,} tree markers")
    return dataset.Dataset(name=ds.name, label=ds.label, tag=ds.tag, profile=ds.profile, scenes=scenes,
                           geoms=out_geoms, instances=out_instances, materials=ds.materials, paths=ds.paths)
