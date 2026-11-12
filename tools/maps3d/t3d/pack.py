"""Deterministic container: magic | header-json | 16-byte aligned arrays.

Writing the same meta + arrays always yields the same bytes, so unchanged
cache files stay unchanged in git/LFS after a re-extract. `write`/`read` wrap
it in zstd (the extraction cache); the map datasets store it themselves.

An array can be stored through a lossless meshoptimizer codec (`Coded`): its
header entry then has "codec" and "segments" ([[elements, bytes], ...]: the
array is cut into pieces that are encoded on their own and stored back to
back). A pack with such arrays has version 2; the viewer decodes it with the
meshopt decoder that comes with three.js (web/src/map3d/container.ts).
"""

from __future__ import annotations

import io
import json
import os
import struct
from compression import zstd
from dataclasses import dataclass
from pathlib import Path

import numpy as np

MAGIC = b"T3DP"
VERSION = 1            # raw arrays only
VERSION_CODED = 2      # some arrays are stored through a codec
VERTEX_CODEC = "meshopt-vertex"    # rows of a 2D array; a row is a multiple of 4 bytes
INDEX_CODEC = "meshopt-index"      # triangle list, u2 or u4; a triangle may come back starting at
                                   # another of its corners (same winding)
VERTEX_SEGMENT = 1 << 18           # rows per piece
_PREFIX = struct.Struct("<4sII")  # magic, version, header length
_ZSTD_OPTIONS = {
    zstd.CompressionParameter.compression_level: 15,
    zstd.CompressionParameter.nb_workers: 4,
    zstd.CompressionParameter.checksum_flag: 1,
}


@dataclass
class Coded:
    """An array to be stored through a codec.

    `segments`: element counts of the pieces (rows for vertices, indices for
    triangle lists; they add up to the array). An index piece should be one
    mesh: the codec predicts each new vertex from the ones before it."""
    array: np.ndarray
    codec: str
    segments: list | None = None


def _encode_coded(coded: Coded):
    """-> (contiguous array, [[elements, bytes], ...], encoded pieces)."""
    import meshoptimizer as mo

    a = np.ascontiguousarray(coded.array)
    if coded.codec == VERTEX_CODEC:
        if a.ndim != 2 or (a.shape[1] * a.dtype.itemsize) % 4:
            raise ValueError(f"{VERTEX_CODEC}: rows must be a multiple of 4 bytes, got {a.dtype}{a.shape}")
        counts = coded.segments or [min(VERTEX_SEGMENT, len(a) - i) for i in range(0, len(a), VERTEX_SEGMENT)]
        size = a.shape[1] * a.dtype.itemsize
        encode = lambda piece: mo.encode_vertex_buffer(piece, len(piece), size)
    elif coded.codec == INDEX_CODEC:
        if a.ndim != 1 or a.dtype.str not in ("<u2", "<u4"):
            raise ValueError(f"{INDEX_CODEC}: expected a u2 or u4 vector, got {a.dtype}{a.shape}")
        counts = coded.segments if coded.segments is not None else [len(a)]
        encode = lambda piece: mo.encode_index_buffer(piece.astype(np.uint32), len(piece), int(piece.max()) + 1)
    else:
        raise ValueError(f"unknown codec {coded.codec!r}")
    counts = [int(c) for c in counts if c]
    if sum(counts) != len(a):
        raise ValueError(f"{coded.codec}: segments cover {sum(counts)} of {len(a)} elements")
    segments, pieces, start = [], [], 0
    for count in counts:
        data = bytes(encode(a[start:start + count]))
        segments.append([count, len(data)])
        pieces.append(data)
        start += count
    return a, segments, pieces


def _decode_coded(d: dict, data: memoryview) -> np.ndarray:
    import meshoptimizer as mo

    dtype = np.dtype(d["dtype"])
    out = np.empty(d["shape"], dtype=dtype)
    flat = out.reshape(-1).view(np.uint8)
    row = out.nbytes // max(1, d["shape"][0]) if d["shape"] else dtype.itemsize
    start = offset = 0
    for count, size in d["segments"]:
        piece = bytes(data[offset:offset + size])
        if d["codec"] == VERTEX_CODEC:
            # The binding allocates `count` elements of the dtype: one element must be a whole row.
            decoded = mo.decode_vertex_buffer(count, row, piece, np.dtype(f"V{row}"))
        elif d["codec"] == INDEX_CODEC:
            # Always a u4 buffer; 2-byte indices fill the first half of it.
            decoded = mo.decode_index_buffer(count, dtype.itemsize, piece)
        else:
            raise ValueError(f"unknown codec {d['codec']!r}")
        flat[start * row:(start + count) * row] = decoded.view(np.uint8)[:count * row]
        start += count
        offset += size
    return out


def _canonical_json(obj) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def encode(meta: dict, arrays: dict) -> bytes:
    """`arrays`: name -> ndarray (stored as it is) or `Coded`."""
    descr = {}
    offset = 0
    blobs = []
    coded = False
    for name in sorted(arrays):
        entry = {}
        if isinstance(arrays[name], Coded):
            a, entry["segments"], pieces = _encode_coded(arrays[name])
            entry["codec"] = arrays[name].codec
            data = b"".join(pieces)
            coded = True
        else:
            a = np.ascontiguousarray(arrays[name])
            if a.dtype.byteorder == ">":
                a = a.astype(a.dtype.newbyteorder("<"))
            data = a.tobytes()
        pad = (-offset) % 16
        offset += pad
        descr[name] = {"offset": offset, "dtype": a.dtype.str, "shape": list(a.shape)} | entry
        blobs.append((pad, data))
        offset += len(data)
    header = _canonical_json({"meta": meta, "arrays": descr})
    out = io.BytesIO()
    out.write(_PREFIX.pack(MAGIC, VERSION_CODED if coded else VERSION, len(header)))
    out.write(header)
    out.write(b"\0" * ((-out.tell()) % 16))
    for pad, data in blobs:
        out.write(b"\0" * pad)
        out.write(data)
    return out.getvalue()


def write(path: Path, meta: dict, arrays: dict[str, np.ndarray]) -> int:
    """Atomically write a pack; returns the compressed size."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    data = zstd.compress(encode(meta, arrays), options=_ZSTD_OPTIONS)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)
    return len(data)


def decode(raw: bytes):
    magic, version, hlen = _PREFIX.unpack_from(raw, 0)
    if magic != MAGIC or version not in (VERSION, VERSION_CODED):
        raise ValueError(f"not a T3DP v{VERSION}/v{VERSION_CODED} pack (magic={magic!r}, version={version})")
    header = json.loads(raw[_PREFIX.size : _PREFIX.size + hlen])
    base = _PREFIX.size + hlen
    base += (-base) % 16
    buf = memoryview(raw)
    arrays = {}
    for name, d in header["arrays"].items():
        if "codec" in d:
            arrays[name] = _decode_coded(d, buf[base + d["offset"]:])
            continue
        dtype = np.dtype(d["dtype"])
        count = int(np.prod(d["shape"])) if d["shape"] else 1
        arrays[name] = np.frombuffer(buf, dtype=dtype, count=count, offset=base + d["offset"]).reshape(d["shape"])
    return header["meta"], arrays


def read(path: Path):
    """Return (meta, arrays). Raw arrays are read-only views into the decompressed buffer."""
    with open(path, "rb") as f:
        return decode(zstd.decompress(f.read()))


def read_meta(path: Path) -> dict:
    """Read only the header (streams just the first few KB/MB)."""
    with zstd.open(path, "rb") as f:
        prefix = f.read(_PREFIX.size)
        magic, version, hlen = _PREFIX.unpack(prefix)
        if magic != MAGIC or version not in (VERSION, VERSION_CODED):
            raise ValueError(f"not a T3DP pack: {path}")
        return json.loads(f.read(hlen))["meta"]
