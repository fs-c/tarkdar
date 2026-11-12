"""On-disk extraction cache: everything downstream needs, without the game.

Layout (root = tools/maps3d/cache):

    manifest.json                    scenes, maps, provenance (plain text)
    meshes/<hh>.pack.zst             content-addressed mesh store, sharded by
                                     the first byte of the mesh hash
    textures/<h>.pack.zst            content-addressed RGBA8 thumbnails (albedo,
                                     terrain layers/splat maps), sharded by the
                                     first hex digit of the pixel hash
    scenes/<scene path>.pack.zst     per-scene renderers, LOD groups,
                                     colliders, terrains

All geometry and matrices are stored in **Unity space** (left-handed, raw
vertex data, original winding). Coordinate conversion to three.js happens in
the build stage, so the cache does not encode any viewer convention.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import struct
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from . import pack

CACHE_FORMAT = 2
DEFAULT_ROOT = Path(__file__).resolve().parents[1] / "cache"

# Unity VertexAttributeFormat ids used for normals that the build understands.
NORMAL_FORMATS = {0: np.dtype("<f4"), 1: np.dtype("<f2"), 2: np.dtype(np.uint8), 3: np.dtype(np.int8)}

# Unity VertexAttributeFormat -> numpy dtype (raw storage; unorm/snorm are not
# rescaled). Used for the extra vertex attributes kept verbatim.
VERTEX_FORMATS = {
    0: np.dtype("<f4"), 1: np.dtype("<f2"), 2: np.dtype(np.uint8), 3: np.dtype(np.int8),
    4: np.dtype("<u2"), 5: np.dtype("<i2"), 6: np.dtype(np.uint8), 7: np.dtype(np.int8),
    8: np.dtype("<u2"), 9: np.dtype("<i2"), 10: np.dtype("<u4"), 11: np.dtype("<i4"),
}
# Unity 2019+ vertex channel ids. 0/1 (position/normal) are stored as fields;
# tangents (2) are recomputable and skin weights (12/13) unused, so not kept.
CHANNEL_NAMES = {3: "color", 4: "uv0", 5: "uv1", 6: "uv2", 7: "uv3", 8: "uv4", 9: "uv5", 10: "uv6", 11: "uv7"}
KEPT_CHANNELS = tuple(CHANNEL_NAMES)


def decode_vertex_attribute(fmt: int, raw: np.ndarray) -> np.ndarray:
    """Raw attribute -> float32 with Unity's normalization (unorm/snorm 8/16)."""
    if fmt in (0, 1):
        return raw.astype(np.float32)
    if fmt == 2:
        return raw.astype(np.float32) / 255.0
    if fmt == 3:
        return np.clip(raw.astype(np.float32) / 127.0, -1, 1)
    if fmt == 4:
        return raw.astype(np.float32) / 65535.0
    if fmt == 5:
        return np.clip(raw.astype(np.float32) / 32767.0, -1, 1)
    return raw.astype(np.float32)  # integer formats: as-is


def scene_key(scene_path: str) -> str:
    """'Assets/Content/Locations/City/x.unity' -> 'Content/Locations/City/x'."""
    key = scene_path.replace("\\", "/")
    if key.startswith("Assets/"):
        key = key[len("Assets/"):]
    if key.endswith(".unity"):
        key = key[: -len(".unity")]
    return key


# ---------------------------------------------------------------------------
# Manifest
# ---------------------------------------------------------------------------

def load_manifest(root: Path = DEFAULT_ROOT) -> dict:
    path = Path(root) / "manifest.json"
    if not path.exists():
        return {"format": CACHE_FORMAT, "scenes": {}, "maps": {}}
    manifest = json.loads(path.read_text())
    if manifest.get("format") != CACHE_FORMAT:
        raise ValueError(f"cache format {manifest.get('format')} != {CACHE_FORMAT}; re-extract")
    return manifest


def save_manifest(manifest: dict, root: Path = DEFAULT_ROOT) -> None:
    path = Path(root) / "manifest.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(manifest, indent=1, sort_keys=True) + "\n")
    tmp.replace(path)


def scene_file(root: Path, key: str) -> Path:
    return Path(root) / "scenes" / f"{key}.pack.zst"


def write_scene(root: Path, key: str, meta: dict, arrays: dict) -> int:
    return pack.write(scene_file(root, key), meta, arrays)


def read_scene(root: Path, key: str):
    return pack.read(scene_file(root, key))


# ---------------------------------------------------------------------------
# Mesh store
# ---------------------------------------------------------------------------

@dataclass
class Mesh:
    hash: str
    positions: np.ndarray        # (V, 3) float32, Unity space
    indices: np.ndarray          # (I,) uint32, baseVertex applied, unfiltered
    submeshes: list              # [[firstIndex, indexCount, topology], ...]
    normals_raw: np.ndarray | None  # (V, dim) in the source vertex format
    normal_format: int | None
    # Extra vertex channels kept verbatim: channel id -> (format, (V, dim) raw).
    # See CHANNEL_NAMES / decode_vertex_attribute.
    attributes: dict = field(default_factory=dict)

    @property
    def vertex_count(self) -> int:
        return len(self.positions)

    def normals(self) -> np.ndarray | None:
        """Decoded (V, 3) float32 normals, Unity space, not renormalized."""
        if self.normals_raw is None:
            return None
        n = self.normals_raw[:, :3]
        fmt = self.normal_format
        if fmt == 0 or fmt == 1:
            return n.astype(np.float32)
        if fmt == 2:
            return n.astype(np.float32) / 255.0 * 2.0 - 1.0
        if fmt == 3:
            return np.clip(n.astype(np.float32) / 127.0, -1, 1)
        raise ValueError(f"unsupported normal format {fmt}")

    def attribute(self, name: str) -> np.ndarray | None:
        """Decoded float32 attribute by name ('uv0', 'color', ...), or None."""
        ch = {v: k for k, v in CHANNEL_NAMES.items()}[name]
        if ch not in self.attributes:
            return None
        fmt, raw = self.attributes[ch]
        return decode_vertex_attribute(fmt, raw)


def mesh_hash(positions: np.ndarray, indices: np.ndarray, submeshes, normals_raw, normal_format,
              attributes: dict | None = None) -> str:
    h = hashlib.blake2b(digest_size=16)
    h.update(np.ascontiguousarray(positions, dtype="<f4").tobytes())
    h.update(np.ascontiguousarray(indices, dtype="<u4").tobytes())
    h.update(json.dumps(submeshes).encode())
    if normals_raw is not None:
        h.update(str(normal_format).encode())
        h.update(np.ascontiguousarray(normals_raw).tobytes())
    for ch in sorted(attributes or {}):
        fmt, raw = attributes[ch]
        h.update(f"|{ch}:{fmt}:{raw.shape[1]}|".encode())
        h.update(np.ascontiguousarray(raw).tobytes())
    return h.hexdigest()


_STAGE_HEAD = struct.Struct("<IQQQQ")


class MeshStore:
    """Content-addressed, sharded mesh store with on-disk staging.

    `add` appends to `.staging/<hh>.bin`; `flush` merges staged meshes into
    the compressed shards. Readers only ever see flushed shards.
    """

    def __init__(self, root: Path = DEFAULT_ROOT):
        self.root = Path(root)
        self.shard_dir = self.root / "meshes"
        self.stage_dir = self.root / ".staging"
        self._known: set[str] | None = None
        self._staged = 0

    # -- writing -----------------------------------------------------------

    def discard_staging(self) -> None:
        if self.stage_dir.exists():
            shutil.rmtree(self.stage_dir)
        self._known = None
        self._staged = 0

    def known(self) -> set[str]:
        if self._known is None:
            known = set()
            if self.shard_dir.exists():
                for p in sorted(self.shard_dir.glob("*.pack.zst")):
                    known.update(m["hash"] for m in pack.read_meta(p)["meshes"])
            self._known = known
        return self._known

    def add(self, mesh: Mesh) -> None:
        known = self.known()
        if mesh.hash in known:
            return
        known.add(mesh.hash)
        meta = {
            "hash": mesh.hash,
            "submeshes": mesh.submeshes,
            "normalFormat": mesh.normal_format,
            "normalDim": None if mesh.normals_raw is None else int(mesh.normals_raw.shape[1]),
            "vertexCount": int(len(mesh.positions)),
            "attrs": [[ch, fmt, int(raw.shape[1])] for ch, (fmt, raw) in sorted(mesh.attributes.items())],
        }
        mj = json.dumps(meta).encode()
        pos = np.ascontiguousarray(mesh.positions, dtype="<f4").tobytes()
        nrm = b"" if mesh.normals_raw is None else np.ascontiguousarray(mesh.normals_raw).tobytes()
        idx = np.ascontiguousarray(mesh.indices, dtype="<u4").tobytes()
        att = b"".join(np.ascontiguousarray(raw, dtype=VERTEX_FORMATS[fmt]).tobytes()
                       for _, (fmt, raw) in sorted(mesh.attributes.items()))
        self.stage_dir.mkdir(parents=True, exist_ok=True)
        with open(self.stage_dir / f"{mesh.hash[:2]}.bin", "ab") as f:
            f.write(_STAGE_HEAD.pack(len(mj), len(pos), len(nrm), len(idx), len(att)))
            f.write(mj)
            f.write(pos)
            f.write(nrm)
            f.write(idx)
            f.write(att)
        self._staged += len(pos) + len(nrm) + len(idx) + len(att)

    @property
    def staged_bytes(self) -> int:
        return self._staged

    def _read_staging(self, path: Path):
        data = path.read_bytes()
        off = 0
        while off < len(data):
            jl, pl, nl, il, al = _STAGE_HEAD.unpack_from(data, off)
            off += _STAGE_HEAD.size
            meta = json.loads(data[off : off + jl]); off += jl
            vc = meta["vertexCount"]
            pos = np.frombuffer(data, "<f4", count=pl // 4, offset=off).reshape(vc, 3); off += pl
            nrm = None
            if meta["normalFormat"] is not None:
                dt = NORMAL_FORMATS[meta["normalFormat"]]
                nrm = np.frombuffer(data, dt, count=nl // dt.itemsize, offset=off).reshape(vc, meta["normalDim"])
            off += nl
            idx = np.frombuffer(data, "<u4", count=il // 4, offset=off); off += il
            attrs = {}
            for ch, fmt, dim in meta["attrs"]:
                dt = VERTEX_FORMATS[fmt]
                attrs[ch] = (fmt, np.frombuffer(data, dt, count=vc * dim, offset=off).reshape(vc, dim))
                off += vc * dim * dt.itemsize
            yield Mesh(meta["hash"], pos, idx, meta["submeshes"], nrm, meta["normalFormat"], attrs)

    def flush(self) -> int:
        """Merge staging into shards. Returns number of shards rewritten."""
        if not self.stage_dir.exists():
            return 0
        rewritten = 0
        for stage in sorted(self.stage_dir.glob("*.bin")):
            shard = stage.stem
            meshes = {m.hash: m for m in self.load_shard(shard)}
            for m in self._read_staging(stage):
                meshes.setdefault(m.hash, m)
            self._write_shard(shard, [meshes[h] for h in sorted(meshes)])
            stage.unlink()
            rewritten += 1
        self.stage_dir.rmdir()
        self._staged = 0
        return rewritten

    def _write_shard(self, shard: str, meshes: list[Mesh]) -> None:
        records = []
        pos, idx = [], []
        nrm = {fmt: [] for fmt in NORMAL_FORMATS}
        nrm_off = {fmt: 0 for fmt in NORMAL_FORMATS}
        att: dict[str, list] = {}
        att_off: dict[str, int] = {}
        voff = ioff = 0
        for m in meshes:
            rec = {
                "hash": m.hash,
                "vertexOffset": voff,
                "vertexCount": m.vertex_count,
                "indexOffset": ioff,
                "indexCount": int(len(m.indices)),
                "submeshes": m.submeshes,
                "normalFormat": m.normal_format,
            }
            if m.normals_raw is not None:
                rec["normalDim"] = int(m.normals_raw.shape[1])
                rec["normalOffset"] = nrm_off[m.normal_format]
                nrm[m.normal_format].append(m.normals_raw.reshape(-1))
                nrm_off[m.normal_format] += m.normals_raw.size
            if m.attributes:
                rec["attrs"] = {}
                for ch, (fmt, raw) in sorted(m.attributes.items()):
                    name = f"attr{ch}f{fmt}"
                    rec["attrs"][str(ch)] = [fmt, int(raw.shape[1]), att_off.get(name, 0)]
                    att.setdefault(name, []).append(np.asarray(raw, VERTEX_FORMATS[fmt]).reshape(-1))
                    att_off[name] = att_off.get(name, 0) + raw.size
            records.append(rec)
            pos.append(m.positions)
            idx.append(m.indices)
            voff += m.vertex_count
            ioff += len(m.indices)
        arrays = {
            "positions": np.concatenate(pos).astype("<f4") if pos else np.zeros((0, 3), "<f4"),
            "indices": np.concatenate(idx).astype("<u4") if idx else np.zeros(0, "<u4"),
        }
        for fmt, parts in nrm.items():
            if parts:
                arrays[f"normals{fmt}"] = np.concatenate(parts).astype(NORMAL_FORMATS[fmt])
        for name, parts in att.items():
            arrays[name] = np.concatenate(parts)
        pack.write(self.shard_dir / f"{shard}.pack.zst", {"meshes": records}, arrays)

    # -- reading -----------------------------------------------------------

    def load_shard(self, shard: str) -> list[Mesh]:
        path = self.shard_dir / f"{shard}.pack.zst"
        if not path.exists():
            return []
        meta, arrays = pack.read(path)
        out = []
        for r in meta["meshes"]:
            v0, vc = r["vertexOffset"], r["vertexCount"]
            i0, ic = r["indexOffset"], r["indexCount"]
            nrm = None
            fmt = r["normalFormat"]
            if fmt is not None:
                dim = r["normalDim"]
                flat = arrays[f"normals{fmt}"]
                nrm = flat[r["normalOffset"] : r["normalOffset"] + vc * dim].reshape(vc, dim)
            attrs = {}
            for ch, (afmt, dim, aoff) in r.get("attrs", {}).items():
                flat = arrays[f"attr{ch}f{afmt}"]
                attrs[int(ch)] = (afmt, flat[aoff : aoff + vc * dim].reshape(vc, dim))
            out.append(Mesh(r["hash"], arrays["positions"][v0 : v0 + vc], arrays["indices"][i0 : i0 + ic],
                            r["submeshes"], nrm, fmt, attrs))
        return out

    def iter_meshes(self, hashes):
        """Yield Mesh objects for the given hashes, loading each shard once."""
        by_shard: dict[str, set[str]] = {}
        for h in hashes:
            by_shard.setdefault(h[:2], set()).add(h)
        for shard in sorted(by_shard):
            wanted = by_shard[shard]
            found = 0
            for m in self.load_shard(shard):
                if m.hash in wanted:
                    found += 1
                    yield m
            if found != len(wanted):
                raise KeyError(f"{len(wanted) - found} meshes missing from shard {shard}")


# ---------------------------------------------------------------------------
# Texture store
# ---------------------------------------------------------------------------

def texture_hash(rgba: np.ndarray) -> str:
    h = hashlib.blake2b(digest_size=16)
    h.update(f"{rgba.shape[1]}x{rgba.shape[0]}|".encode())
    h.update(np.ascontiguousarray(rgba, dtype=np.uint8).tobytes())
    return h.hexdigest()


class TextureStore:
    """Content-addressed RGBA8 images (thumbnails), 16 shards by first hex digit.

    Small enough to buffer in memory between flushes. Images are stored
    top-row-first (as decoded by PIL), i.e. *not* Unity's bottom-up order.
    """

    def __init__(self, root: Path = DEFAULT_ROOT):
        self.dir = Path(root) / "textures"
        self._pending: dict[str, np.ndarray] = {}
        self._known: set[str] | None = None

    def known(self) -> set[str]:
        if self._known is None:
            known = set()
            for p in sorted(self.dir.glob("*.pack.zst")) if self.dir.exists() else []:
                known.update(r["hash"] for r in pack.read_meta(p)["textures"])
            self._known = known
        return self._known

    def add(self, rgba: np.ndarray) -> str:
        h = texture_hash(rgba)
        if h not in self.known():
            self.known().add(h)
            self._pending[h] = np.ascontiguousarray(rgba, dtype=np.uint8)
        return h

    def discard_pending(self) -> None:
        self._pending.clear()
        self._known = None

    def load_shard(self, shard: str) -> dict[str, np.ndarray]:
        path = self.dir / f"{shard}.pack.zst"
        if not path.exists():
            return {}
        meta, arrays = pack.read(path)
        px = arrays["pixels"]
        return {r["hash"]: px[r["offset"] : r["offset"] + r["height"] * r["width"] * 4].reshape(r["height"], r["width"], 4)
                for r in meta["textures"]}

    def flush(self) -> int:
        by_shard: dict[str, dict] = {}
        for h, img in self._pending.items():
            by_shard.setdefault(h[0], {})[h] = img
        for shard, new in sorted(by_shard.items()):
            images = self.load_shard(shard)
            images.update(new)
            records, parts, off = [], [], 0
            for h in sorted(images):
                img = images[h]
                records.append({"hash": h, "width": int(img.shape[1]), "height": int(img.shape[0]), "offset": off})
                parts.append(img.reshape(-1))
                off += img.size
            pack.write(self.dir / f"{shard}.pack.zst", {"textures": records},
                       {"pixels": np.concatenate(parts) if parts else np.zeros(0, np.uint8)})
        self._pending.clear()
        return len(by_shard)

    def get(self, hashes) -> dict[str, np.ndarray]:
        want: dict[str, set] = {}
        for h in hashes:
            want.setdefault(h[0], set()).add(h)
        out = {}
        for shard, hs in want.items():
            images = self.load_shard(shard)
            missing = hs - images.keys()
            if missing:
                raise KeyError(f"{len(missing)} textures missing from shard {shard}")
            out.update({h: images[h] for h in hs})
        return out
