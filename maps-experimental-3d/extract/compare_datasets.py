#!/usr/bin/env python3
"""Compare two viewer datasets (format 2) for exact equality.

    python extract/compare_datasets.py <dirA> <dirB>

Exit status 0 when identical. Otherwise it reports which header keys, chunk
arrays or source paths differ.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from t3d import dataset  # noqa: E402


def compare(a_dir: Path, b_dir: Path, log=print) -> bool:
    ia, ca, sa = dataset.read(a_dir)
    ib, cb, sb = dataset.read(b_dir)
    ok = True
    for k in sorted(set(ia) | set(ib)):
        if ia.get(k) != ib.get(k):
            ok = False
            log(f"index[{k}] differs:\n  A={str(ia.get(k))[:300]}\n  B={str(ib.get(k))[:300]}")
    if len(ca) != len(cb):
        ok = False
        log(f"chunk count differs: {len(ca)} vs {len(cb)}")
    for n, ((ma, aa), (mb, ab)) in enumerate(zip(ca, cb)):
        for k in sorted(set(ma) | set(mb)):
            if ma.get(k) != mb.get(k):
                ok = False
                log(f"chunk {n} meta[{k}] differs")
        for k in sorted(set(aa) | set(ab)):
            if k not in aa or k not in ab:
                ok = False
                log(f"chunk {n} array {k}: only in {'A' if k in aa else 'B'}")
            elif aa[k].shape != ab[k].shape or aa[k].dtype != ab[k].dtype:
                ok = False
                log(f"chunk {n} array {k}: {aa[k].dtype}{aa[k].shape} vs {ab[k].dtype}{ab[k].shape}")
            elif not np.array_equal(aa[k], ab[k]):
                ok = False
                rows = np.argwhere(aa[k] != ab[k])
                log(f"chunk {n} array {k}: {len(rows):,} elements differ, first at {rows[0].tolist()}")
    if sa != sb:
        ok = False
        log(f"sources differ: {len(sa['paths']):,} vs {len(sb['paths']):,} paths")
    log("IDENTICAL" if ok else "DIFFERENT")
    return ok


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    sys.exit(0 if compare(Path(sys.argv[1]), Path(sys.argv[2])) else 1)


if __name__ == "__main__":
    main()
