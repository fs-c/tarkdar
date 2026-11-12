"""Deterministic container: zstd( magic | header-json | 16-byte aligned arrays ).

Writing the same meta + arrays always yields the same bytes, so unchanged
cache files stay unchanged in git/LFS after a re-extract.
"""

from __future__ import annotations

import io
import json
import os
import struct
from compression import zstd
from pathlib import Path

import numpy as np

MAGIC = b"T3DP"
VERSION = 1
_PREFIX = struct.Struct("<4sII")  # magic, version, header length
_ZSTD_OPTIONS = {
    zstd.CompressionParameter.compression_level: 15,
    zstd.CompressionParameter.nb_workers: 4,
    zstd.CompressionParameter.checksum_flag: 1,
}


def _canonical_json(obj) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def encode(meta: dict, arrays: dict[str, np.ndarray]) -> bytes:
    descr = {}
    offset = 0
    blobs = []
    for name in sorted(arrays):
        a = np.ascontiguousarray(arrays[name])
        if a.dtype.byteorder == ">":
            a = a.astype(a.dtype.newbyteorder("<"))
        pad = (-offset) % 16
        offset += pad
        descr[name] = {"offset": offset, "dtype": a.dtype.str, "shape": list(a.shape)}
        blobs.append((pad, a.tobytes()))
        offset += a.nbytes
    header = _canonical_json({"meta": meta, "arrays": descr})
    out = io.BytesIO()
    out.write(_PREFIX.pack(MAGIC, VERSION, len(header)))
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
    if magic != MAGIC or version != VERSION:
        raise ValueError(f"not a T3DP v{VERSION} pack (magic={magic!r}, version={version})")
    header = json.loads(raw[_PREFIX.size : _PREFIX.size + hlen])
    base = _PREFIX.size + hlen
    base += (-base) % 16
    buf = memoryview(raw)
    arrays = {}
    for name, d in header["arrays"].items():
        dtype = np.dtype(d["dtype"])
        count = int(np.prod(d["shape"])) if d["shape"] else 1
        arrays[name] = np.frombuffer(buf, dtype=dtype, count=count, offset=base + d["offset"]).reshape(d["shape"])
    return header["meta"], arrays


def read(path: Path):
    """Return (meta, arrays). Arrays are read-only views into the decompressed buffer."""
    with open(path, "rb") as f:
        return decode(zstd.decompress(f.read()))


def read_meta(path: Path) -> dict:
    """Read only the header (streams just the first few KB/MB)."""
    with zstd.open(path, "rb") as f:
        prefix = f.read(_PREFIX.size)
        magic, version, hlen = _PREFIX.unpack(prefix)
        if magic != MAGIC or version != VERSION:
            raise ValueError(f"not a T3DP v{VERSION} pack: {path}")
        return json.loads(f.read(hlen))["meta"]
