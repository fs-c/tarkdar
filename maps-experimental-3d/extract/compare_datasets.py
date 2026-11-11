#!/usr/bin/env python3
"""Compare two viewer datasets (bin + json) for exact or near equality.

    python extract/compare_datasets.py <dirA> <dirB> [name]
"""

from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path


def load(d: Path, name: str):
    return json.loads((d / f"{name}.json").read_text()), (d / f"{name}.bin").read_bytes()


def main():
    a_dir, b_dir = Path(sys.argv[1]), Path(sys.argv[2])
    name = sys.argv[3] if len(sys.argv) > 3 else a_dir.name
    a, abin = load(a_dir, name)
    b, bbin = load(b_dir, name)
    ok = True

    print(f"bin: {len(abin):,} vs {len(bbin):,} bytes -> {'identical' if abin == bbin else 'DIFFERENT'}")
    ok &= abin == bbin
    for k in sorted(set(a) | set(b)):
        if k in ("meshes", "instances"):
            continue
        if a.get(k) != b.get(k):
            ok = False
            print(f"json[{k}] differs:\n  A={str(a.get(k))[:300]}\n  B={str(b.get(k))[:300]}")
    if a["meshes"] != b["meshes"]:
        ok = False
        na = Counter(m["name"] for m in a["meshes"])
        nb = Counter(m["name"] for m in b["meshes"])
        print(f"meshes differ: {len(a['meshes'])} vs {len(b['meshes'])}; "
              f"only A: {list((na - nb).items())[:10]} only B: {list((nb - na).items())[:10]}")
        for i, (x, y) in enumerate(zip(a["meshes"], b["meshes"])):
            if x != y:
                print(f"  first diff at mesh {i}: {x} vs {y}")
                break
    if a["instances"] != b["instances"]:
        ok = False
        print(f"instances differ: {len(a['instances'])} vs {len(b['instances'])}")
        for i, (x, y) in enumerate(zip(a["instances"], b["instances"])):
            if x != y:
                print(f"  first diff at instance {i}: {x} vs {y}")
                break
    print("IDENTICAL" if ok else "DIFFERENT")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
