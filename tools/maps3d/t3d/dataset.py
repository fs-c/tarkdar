"""3D map dataset, format 3: `index.json` + binary chunks (+ draped images).

    <out>/index.json     small header: map, bounds, categories, scenes,
                         materials, stats and the list of chunks
    <out>/chunk-0.t3d    geometry chunk: a gzipped t3d.pack container
    <out>/texture-N.png  colour image draped over mesh N (terrain ground colour);
                         listed in the chunk header as meshTextures

A chunk is self-describing (its own JSON header + arrays), so later phases can
add one chunk per spatial cell and LOD level without touching the header
layout. Today there is one chunk of kind "instanced":

    mesh_*   one row per unique mesh: vertex/index ranges, parts, local bounds,
             flags (1 = flat shaded: per-face normals, the normals array is unused)
    part_*   submesh index ranges of a mesh, relative to the mesh's indices
    inst_*   one row per placed renderer: mesh, scene, 3x4 matrix, slots
    slot_*   one row per (instance, part): category, flags, colour, material
    colors   optional: baked per-vertex colour (sRGB), parallel to positions
    ground_height, ground_building
             optional (t3d/ground.py): ground height and "a building stands here"
             (u8, 0 or 255) on a grid, rows along z; the header's `ground` has the grid's
             origin (x, z of the corner of cell 0, 0) and cell size

The file is about an eighth of the arrays it holds (`_stored` / `expand`, mirrored by
`expandChunk` in web/src/map3d/dataset.ts):

    positions      u16 x 4 (the 4th is padding): a position within the mesh's `mesh_bounds`,
                   0..65535 per axis: at most 4 mm off in a 500 m cell
    normals        i8 x 4 (padding); all zero for flat shaded meshes
    ground_height  u16: steps of `ground.heightStep` above `ground.heightBase`, each row
                   as differences to the cell before (modulo 65536)
    positions, normals, colors, indices16, indices32
                   through the meshoptimizer vertex / index codecs (t3d/pack.py), which work
                   because `optimise` puts every mesh's triangles and vertices in an order
                   in which neighbours are alike
    the whole file gzipped (the browser unpacks it with DecompressionStream)

Readers (`read` here, `loadMapData` in the viewer) undo all of it: what they hand on are
float positions, 3-byte normals and float ground heights, as the arrays are described above.

Everything is in three.js space (see geometry.py). Matrices are the first
three rows of the world matrix, column-major (12 floats).
"""

from __future__ import annotations

import gzip
import json
from dataclasses import dataclass, field, replace
from pathlib import Path

import numpy as np

from . import geometry, pack
from .classify import CATEGORIES, CATEGORY_ID, FLAG_CUTOUT, FLAG_TRANSPARENT

FORMAT = 3
GROUND_STEP = 0.02       # metres: resolution of the stored ground heights
GZIP_MAGIC = b"\x1f\x8b"
INDEX_NAME = "index.json"
NO_COLOR = (0, 0, 0, 0)  # alpha 0: the viewer falls back to the category colour
MESH_FLAT = 1            # mesh_flags bit: flat shaded


@dataclass
class Geom:
    name: str
    kind: str                 # "mesh" | "terrain"
    positions: np.ndarray     # (V, 3) float32
    normals: np.ndarray       # (V, 3) float32, unit length
    indices: np.ndarray       # (I,) uint32
    parts: np.ndarray         # (P, 2) uint32 [first index, index count]
    colors: np.ndarray | None = None   # (V, 4) uint8 sRGB, baked per-vertex colour
    flat: bool = False        # shade per face (normals are not used and may be zero)
    # Colour image draped over the mesh (terrain): (H, W, 3) uint8 sRGB and the
    # local XZ rectangle it covers, [x0, z0, size x, size z]; u = (x - x0) / size x,
    # v = (z - z0) / size z, v = 0 at image row 0.
    texture: np.ndarray | None = None
    texture_rect: tuple | None = None

    def bounds(self):
        if not len(self.positions):
            return np.zeros(3, dtype=np.float32), np.zeros(3, dtype=np.float32)
        return self.positions.min(axis=0), self.positions.max(axis=0)


@dataclass
class Slot:
    category: str
    flags: int = 0
    color: tuple = NO_COLOR   # sRGB bytes, alpha 0 = none
    material: int = -1        # index into Dataset.materials


@dataclass
class Instance:
    geom: int
    matrix: np.ndarray        # (4, 4) float64, three.js space
    scene: int
    slots: list               # one Slot per part of the geom
    path: int = -1            # index into Dataset.paths


@dataclass
class Dataset:
    name: str
    label: str
    tag: str
    profile: str
    scenes: list              # [{"level": ..., "path": ...}]
    geoms: list = field(default_factory=list)
    instances: list = field(default_factory=list)
    materials: list = field(default_factory=list)   # [{"name", "shader", "queue"}]
    paths: list = field(default_factory=list)       # hierarchy paths, by Instance.path (diagnostics; not written)
    build: dict = field(default_factory=dict)       # profile-specific parameters, for the record
    ground: object = None                           # ground.GroundMap: the plan style's ground heights


def _round(values, digits=3):
    return [round(float(v), digits) for v in values]


def optimise(g: Geom) -> Geom:
    """The same mesh with its triangles (within each part) and vertices in the order the
    codecs and a GPU's vertex cache like; unused vertices and a part's incomplete last
    triangle are dropped."""
    import meshoptimizer as mo

    count = len(g.positions)
    pieces, parts = [], []
    for first, length in g.parts.tolist():
        source = np.ascontiguousarray(g.indices[first:first + length - length % 3], dtype=np.uint32)
        piece = np.zeros_like(source)
        if len(source):
            mo.optimize_vertex_cache(piece, source, len(source), count)
        parts.append([sum(len(p) for p in pieces), len(piece)])
        pieces.append(piece)
    indices = np.concatenate(pieces) if pieces else np.zeros(0, dtype=np.uint32)
    if not len(indices):
        return replace(g, positions=g.positions[:0], normals=g.normals[:0], indices=indices,
                       parts=np.array(parts, dtype=np.uint32).reshape(-1, 2),
                       colors=None if g.colors is None else g.colors[:0])
    remap = np.zeros(count, dtype=np.uint32)
    used = mo.optimize_vertex_fetch_remap(remap, indices, len(indices), count)
    order = np.empty(used, dtype=np.int64)          # new vertex -> old vertex
    kept = np.flatnonzero(remap != 0xFFFFFFFF)
    order[remap[kept]] = kept
    return replace(g, positions=g.positions[order], normals=g.normals[order], indices=remap[indices],
                   parts=np.array(parts, dtype=np.uint32), colors=None if g.colors is None else g.colors[order])


def quantise(positions: np.ndarray, lo: np.ndarray, hi: np.ndarray) -> np.ndarray:
    """(V, 3) positions -> (V, 4) u16: 0..65535 between lo and hi per axis; the 4th is padding."""
    extent = (hi - lo).astype(np.float64)
    scale = np.divide(65535.0, extent, out=np.zeros(3), where=extent > 0)
    out = np.zeros((len(positions), 4), dtype="<u2")
    out[:, :3] = np.clip(np.rint((positions.astype(np.float64) - lo) * scale), 0, 65535)
    return out


def dequantise(stored: np.ndarray, lo: np.ndarray, hi: np.ndarray) -> np.ndarray:
    """Inverse of `quantise`, in the arithmetic the viewer uses (float64, rounded to float32 once)."""
    step = (hi.astype(np.float64) - lo) / 65535.0
    return (lo + stored[:, :3] * step).astype(np.float32)


def _chunk_arrays(ds: Dataset):
    """The chunk's arrays as the readers hand them on (`_stored` turns them into what is written)."""
    geoms = ds.geoms
    m = len(geoms)
    vertex_count = np.array([len(g.positions) for g in geoms], dtype=np.uint32)
    index_count = np.array([len(g.indices) for g in geoms], dtype=np.uint32)
    part_count = np.array([len(g.parts) for g in geoms], dtype=np.uint32)
    wide = vertex_count > 65536
    vertex_start = np.zeros(m, dtype=np.uint32)
    index_start = np.zeros(m, dtype=np.uint32)   # element offset in indices16 / indices32
    part_start = np.zeros(m, dtype=np.uint32)
    cursor = {"v": 0, "i16": 0, "i32": 0, "p": 0}
    for i in range(m):
        vertex_start[i] = cursor["v"]
        cursor["v"] += int(vertex_count[i])
        key = "i32" if wide[i] else "i16"
        index_start[i] = cursor[key]
        cursor[key] += int(index_count[i])
        part_start[i] = cursor["p"]
        cursor["p"] += int(part_count[i])

    def cat(arrays, dtype, shape):
        return np.concatenate(arrays).astype(dtype) if arrays else np.zeros(shape, dtype=dtype)

    bounds = np.array([np.concatenate(g.bounds()) for g in geoms], dtype=np.float32).reshape(m, 6)
    # Int8 normals are plenty for untextured lighting (12 -> 3 bytes/vertex).
    normals = [np.clip(np.rint(g.normals * 127.0), -127, 127) for g in geoms]

    n = len(ds.instances)
    inst_slot_start = np.zeros(n, dtype=np.uint32)
    slots = []
    for i, inst in enumerate(ds.instances):
        if len(inst.slots) != part_count[inst.geom]:
            raise ValueError(f"instance {i}: {len(inst.slots)} slots for {part_count[inst.geom]} parts")
        inst_slot_start[i] = len(slots)
        slots.extend(inst.slots)
    matrices = np.array([inst.matrix for inst in ds.instances], dtype=np.float64).reshape(n, 4, 4)

    arrays = {}
    if any(g.colors is not None for g in geoms):
        # All or nothing: the viewer binds one colour attribute per mesh.
        if not all(g.colors is not None for g in geoms):
            raise ValueError("either every mesh has vertex colours or none")
        arrays["colors"] = cat([g.colors for g in geoms], np.uint8, (0, 4))
    return arrays | {
        "mesh_vertex_start": vertex_start,
        "mesh_vertex_count": vertex_count,
        "mesh_index_start": index_start,
        "mesh_index_count": index_count,
        "mesh_index_wide": wide.astype(np.uint8),
        "mesh_part_start": part_start,
        "mesh_part_count": part_count,
        "mesh_bounds": bounds,
        "mesh_flags": np.array([MESH_FLAT if g.flat else 0 for g in geoms], dtype=np.uint8),
        "part_range": cat([g.parts for g in geoms], np.uint32, (0, 2)),
        "positions": cat([g.positions for g in geoms], "<f4", (0, 3)),
        "normals": cat(normals, np.int8, (0, 3)),
        "indices16": cat([g.indices for g, w in zip(geoms, wide) if not w], "<u2", (0,)),
        "indices32": cat([g.indices for g, w in zip(geoms, wide) if w], "<u4", (0,)),
        "inst_mesh": np.array([inst.geom for inst in ds.instances], dtype=np.uint32),
        "inst_scene": np.array([inst.scene for inst in ds.instances], dtype=np.uint16),
        "inst_slot_start": inst_slot_start,
        # rows 0..2 of each column: column-major 3x4
        "inst_matrix": matrices[:, :3, :].transpose(0, 2, 1).reshape(n, 12).astype("<f4"),
        "slot_category": np.array([CATEGORY_ID[s.category] for s in slots], dtype=np.uint8),
        "slot_flags": np.array([s.flags for s in slots], dtype=np.uint8),
        "slot_color": np.array([s.color for s in slots], dtype=np.uint8).reshape(len(slots), 4),
        "slot_material": np.array([s.material for s in slots], dtype=np.int32),
    }


def _stored(arrays: dict, ground: dict | None) -> dict:
    """What is written for `arrays` (see the module docstring). Fills in `ground`'s
    heightBase / heightStep."""
    out = dict(arrays)
    starts, counts = arrays["mesh_vertex_start"], arrays["mesh_vertex_count"]
    bounds = arrays["mesh_bounds"]
    positions = np.zeros((len(arrays["positions"]), 4), dtype="<u2")
    for start, count, box in zip(starts.tolist(), counts.tolist(), bounds):
        positions[start:start + count] = quantise(arrays["positions"][start:start + count], box[:3], box[3:])
    out["positions"] = pack.Coded(positions, pack.VERTEX_CODEC)
    normals = np.zeros((len(arrays["normals"]), 4), dtype=np.int8)
    normals[:, :3] = arrays["normals"]
    out["normals"] = pack.Coded(normals, pack.VERTEX_CODEC)
    if "colors" in arrays:
        out["colors"] = pack.Coded(arrays["colors"], pack.VERTEX_CODEC)
    wide = arrays["mesh_index_wide"].astype(bool)
    for name, selected in (("indices16", ~wide), ("indices32", wide)):
        out[name] = pack.Coded(arrays[name], pack.INDEX_CODEC, arrays["mesh_index_count"][selected].tolist())
    if "ground_height" in arrays:
        heights = arrays["ground_height"].astype(np.float64)
        base = float(np.floor(heights.min() / GROUND_STEP) * GROUND_STEP) if heights.size else 0.0
        step = max(GROUND_STEP, float(heights.max() - base) / 65535.0) if heights.size else GROUND_STEP
        levels = np.rint((heights - base) / step).astype(np.int64)
        ground["heightBase"], ground["heightStep"] = base, step
        out["ground_height"] = np.diff(levels, axis=1, prepend=0).astype("<u2")     # wraps modulo 65536
    return out


def expand(meta: dict, arrays: dict) -> dict:
    """Stored arrays of a chunk -> the arrays as described in the module docstring."""
    out = dict(arrays)
    stored = arrays["positions"]
    positions = np.empty((len(stored), 3), dtype=np.float32)
    for start, count, box in zip(arrays["mesh_vertex_start"].tolist(), arrays["mesh_vertex_count"].tolist(),
                                 arrays["mesh_bounds"]):
        positions[start:start + count] = dequantise(stored[start:start + count], box[:3], box[3:])
    out["positions"] = positions
    out["normals"] = np.ascontiguousarray(arrays["normals"][:, :3])
    if "ground_height" in arrays:
        ground = meta["ground"]
        levels = np.cumsum(arrays["ground_height"], axis=1, dtype=np.uint16)
        out["ground_height"] = (ground["heightBase"] + levels * np.float64(ground["heightStep"])).astype(np.float32)
    return out


def _bounds(ds: Dataset):
    """World bounds of everything, and the 'focus' bounds the camera frames."""
    local = [g.bounds() for g in ds.geoms]
    lo = np.full(3, np.inf)
    hi = np.full(3, -np.inf)
    focus_lo = np.full(3, np.inf)
    focus_hi = np.full(3, -np.inf)
    for inst in ds.instances:
        world = geometry.world_aabb(*local[inst.geom], inst.matrix)
        wmin, wmax = world.min(axis=0), world.max(axis=0)
        lo = np.minimum(lo, wmin)
        hi = np.maximum(hi, wmax)
        if ds.geoms[inst.geom].kind == "terrain":
            focus_lo = np.minimum(focus_lo, wmin)
            focus_hi = np.maximum(focus_hi, wmax)
    if not np.isfinite(focus_lo).all() and ds.instances:
        # No Unity Terrain (e.g. Streets): robust instance-center bounds so a
        # few huge water/border planes do not dominate the initial camera.
        centers = np.array([inst.matrix[:3, 3] for inst in ds.instances])
        focus_lo = np.percentile(centers, 1, axis=0) - np.array([150.0, 50.0, 150.0])
        focus_hi = np.percentile(centers, 99, axis=0) + np.array([150.0, 50.0, 150.0])
    return (lo, hi), (focus_lo, focus_hi)


def focus_bounds(ds: Dataset):
    """(min xyz, max xyz) of the playable area."""
    return _bounds(ds)[1]


def stats(ds: Dataset) -> dict:
    tris = [len(g.indices) // 3 for g in ds.geoms]
    by_category = {c: {"slots": 0, "triangles": 0} for c in CATEGORIES}
    for inst in ds.instances:
        parts = ds.geoms[inst.geom].parts
        for slot, (_, count) in zip(inst.slots, parts.tolist()):
            entry = by_category[slot.category]
            entry["slots"] += 1
            entry["triangles"] += count // 3
    return {
        "sceneCount": len(ds.scenes),
        "meshCount": len(ds.geoms),
        "instanceCount": len(ds.instances),
        "uniqueVertices": int(sum(len(g.positions) for g in ds.geoms)),
        "uniqueTriangles": int(sum(tris)),
        "instancedTriangles": int(sum(tris[inst.geom] for inst in ds.instances)),
        "categories": {c: v for c, v in by_category.items() if v["slots"]},
    }


def png(rgb: np.ndarray) -> bytes:
    """Encode an (H, W, 3) uint8 image as PNG (standard library only)."""
    import struct
    import zlib

    height, width, _ = rgb.shape
    rows = np.zeros((height, 1 + width * 3), dtype=np.uint8)     # filter byte 0 + pixels
    rows[:, 1:] = np.ascontiguousarray(rgb, dtype=np.uint8).reshape(height, -1)

    def block(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    return (b"\x89PNG\r\n\x1a\n" + block(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + block(b"IDAT", zlib.compress(rows.tobytes(), 9)) + block(b"IEND", b""))


def write(ds: Dataset, out_dir: Path) -> dict:
    """Write the dataset; returns the index header."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    ds = replace(ds, geoms=[optimise(g) for g in ds.geoms])
    for stale in out_dir.glob("*.t3d"):
        stale.unlink()

    (lo, hi), (focus_lo, focus_hi) = _bounds(ds)
    bounds = {"min": _round(lo), "max": _round(hi)}
    for stale in out_dir.glob("texture-*.png"):
        stale.unlink()
    textures = {}
    for i, g in enumerate(ds.geoms):
        if g.texture is not None:
            name = f"texture-{i}.png"
            (out_dir / name).write_bytes(png(g.texture))
            textures[str(i)] = {"file": name, "rect": _round(g.texture_rect)}
    chunk_meta = {"kind": "instanced", "level": 0, "error": 0, "cell": None,
                  "meshNames": [g.name for g in ds.geoms], "meshTextures": textures}
    arrays = _chunk_arrays(ds)
    if ds.ground is not None:
        chunk_meta["ground"] = {"origin": _round(ds.ground.origin), "cell": ds.ground.cell}
        arrays["ground_height"] = ds.ground.heights.astype("<f4")
        arrays["ground_building"] = ds.ground.building.astype(np.uint8) * 255
    # mtime 0: the same dataset is the same file.
    data = gzip.compress(pack.encode(chunk_meta, _stored(arrays, chunk_meta.get("ground"))), compresslevel=9, mtime=0)
    chunk_name = "chunk-0.t3d"
    (out_dir / chunk_name).write_bytes(data)

    index = {
        "format": FORMAT,
        "map": ds.name,
        "label": ds.label,
        "tag": ds.tag,
        "source": f"Escape from Tarkov / {ds.label} ({ds.tag})",
        "profile": ds.profile,
        "build": ds.build,
        "categories": CATEGORIES,
        "flags": {"cutout": FLAG_CUTOUT, "transparent": FLAG_TRANSPARENT},
        "scenes": ds.scenes,
        "materials": ds.materials,
        "bounds": bounds,
        "focusBounds": {"min": _round(focus_lo), "max": _round(focus_hi)},
        "stats": stats(ds),
        "chunks": [{"file": chunk_name, "kind": "instanced", "level": 0, "error": 0, "cell": None,
                    "bounds": bounds, "byteLength": len(data)}],
    }
    (out_dir / INDEX_NAME).write_text(json.dumps(index, separators=(",", ":")))
    return index


def read_chunk(path: Path):
    """(chunk meta, arrays) of one chunk file, expanded."""
    data = Path(path).read_bytes()
    if data[:2] == GZIP_MAGIC:
        data = gzip.decompress(data)
    meta, arrays = pack.decode(data)
    return meta, expand(meta, arrays)


def read(out_dir: Path):
    """Read a written dataset back: (index, [(chunk meta, arrays), ...])."""
    out_dir = Path(out_dir)
    index = json.loads((out_dir / INDEX_NAME).read_text())
    if index.get("format") != FORMAT:
        raise ValueError(f"{out_dir}: dataset format {index.get('format')}, expected {FORMAT}")
    return index, [read_chunk(out_dir / c["file"]) for c in index["chunks"]]
