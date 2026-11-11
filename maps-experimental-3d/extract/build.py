#!/usr/bin/env python3
"""Stage 2: cache/ -> viewer dataset (<name>.bin + <name>.json). No game data needed.

    python extract/build.py --map customs                          # overview
    python extract/build.py --map customs --profile inspect
    python extract/build.py --map streets --include-indoor
    python extract/build.py --map customs --profile explore         # full, unfiltered
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from collections import Counter
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from t3d import cache, geometry  # noqa: E402
from t3d.classify import SKIP_NAME_RE, is_terrain  # noqa: E402
from t3d.maps import INDOOR_RE  # noqa: E402

PROFILES = {
    # LOD, min prop size (m), decimation ratio, terrain step, skip noise names
    "overview": {"lod": 1, "min_prop_size": 1.0, "decimate_ratio": 0.8, "terrain_step": 4, "skip_names": True},
    "inspect": {"lod": 0, "min_prop_size": 0.0, "decimate_ratio": 0.0, "terrain_step": 2, "skip_names": True},
    "explore": {"lod": 0, "min_prop_size": 0.0, "decimate_ratio": 0.0, "terrain_step": 2, "skip_names": False},
}


def _digest(p: np.ndarray, idx: np.ndarray) -> bytes:
    h = hashlib.blake2b(digest_size=16)
    h.update(p.tobytes())
    h.update(idx.tobytes())
    return h.digest()


def collect(root: Path, scene_keys: list[str], target_lod: int, skip_names: bool, terrain_step: int):
    """Pass 1: apply per-renderer filters. Returns ordered events + needed mesh hashes."""
    events = []   # ("mesh", scene_index, hash, name, matrix) | ("terrain", scene_index, name, geom, matrix)
    needed = set()
    skipped = Counter()
    levels = []
    for scene_index, key in enumerate(scene_keys):
        meta, a = cache.read_scene(root, key)
        levels.append(meta["level"])
        refs = meta["meshRefs"]
        group_lods = [len(g["heights"]) for g in meta["lodGroups"]]
        n = len(a["r_mesh"])
        # Last membership wins (matches the original extractor). A renderer
        # listed in several groups/levels is judged by the last one only.
        lod_of: dict[int, tuple[int, int]] = {}
        for r, g, lvl in a["lod_members"].tolist():
            if r >= 0:
                lod_of[r] = (g, lvl)
        for i in range(n):
            if not a["r_enabled"][i]:
                skipped["renderer disabled"] += 1
                continue
            mi = int(a["r_mesh"][i])
            if mi < 0 or not a["r_has_transform"][i]:
                skipped["no mesh/transform"] += 1
                continue
            if not a["r_active"][i]:
                skipped["inactive"] += 1
                continue
            lod = lod_of.get(i)
            if lod is not None:
                g, level = lod
                count = group_lods[g]
                chosen = target_lod if target_lod < count else count - 1
                if level != chosen:
                    skipped["other lod"] += 1
                    continue
            ref = refs[mi]
            if skip_names and ref["name"] and SKIP_NAME_RE.search(ref["name"]):
                skipped["noise name"] += 1
                continue
            if ref["hash"] is None:
                skipped["unreadable mesh"] += 1
                continue
            needed.add(ref["hash"])
            events.append(("mesh", scene_index, ref["hash"], ref["name"], np.array(a["r_matrix"][i])))
        for ti, t in enumerate(meta["terrains"]):
            if not t["enabled"] or not t["active"]:
                skipped["terrain disabled/inactive"] += 1
                continue
            heights = a[f"terrain{ti}_heights"]
            built = geometry.terrain_mesh(heights, t["scale"], terrain_step)
            if built is None:
                skipped["terrain failed"] += 1
                continue
            m = np.array(t["matrix"], dtype=np.float64).reshape(4, 4)
            events.append(("terrain", scene_index, f"Terrain_{t['name'] or 'slice'}", built, m))
        del meta, a
    return events, needed, skipped, levels


def process_meshes(root: Path, needed: set[str], decimate_ratio: float, decimate_min_tris: int):
    """Pass 2: convert (and optionally decimate) every needed mesh once."""
    store = cache.MeshStore(root)
    out = {}
    decimated = 0
    for mesh in store.iter_meshes(needed):
        geom = geometry.mesh_to_three(mesh)
        if geom is not None and decimate_ratio > 0 and len(geom[2]) // 3 >= decimate_min_tris:
            try:
                geom = geometry.decimate(*geom, decimate_ratio)
                decimated += 1
            except Exception as exc:  # noqa: BLE001
                print(f"    ! decimate {mesh.hash}: {exc}")
        out[mesh.hash] = geom
    return out, decimated


def build(root: Path, map_name: str, out_dir: Path, name: str, profile: str, *, lod: int,
          min_prop_size: float, decimate_ratio: float, decimate_min_tris: int, terrain_step: int,
          skip_names: bool, include_indoor: bool, prune_min_instances: int, prune_min_size: float):
    t0 = time.time()
    manifest = cache.load_manifest(root)
    if map_name not in manifest["maps"]:
        sys.exit(f"map {map_name!r} not in cache (have: {', '.join(manifest['maps'])})")
    mp = manifest["maps"][map_name]
    drop_indoor = mp.get("indoorOptional", False) and not include_indoor
    scene_keys = [k for k in mp["scenes"] if not (drop_indoor and INDOOR_RE.search(manifest["scenes"][k]["path"]))]
    scene_paths = [manifest["scenes"][k]["path"] for k in scene_keys]
    print(f"Building {map_name}/{profile} from {len(scene_keys)} cached scenes")

    events, needed, skipped, levels = collect(root, scene_keys, lod, skip_names, terrain_step)
    t1 = time.time()
    processed, decimated = process_meshes(root, needed, decimate_ratio, decimate_min_tris)
    print(f"  pass 1: {len(events):,} candidates ({t1 - t0:.1f}s); pass 2: {len(processed):,} meshes, "
          f"{decimated:,} decimated ({time.time() - t1:.1f}s)")
    if skipped:
        print("  skipped: " + ", ".join(f"{v:,} {k}" for k, v in skipped.most_common()))

    # Pass 3: register geometry in first-seen order, apply size cutoff.
    geoms, bounds = [], []
    by_digest: dict[bytes, int] = {}
    by_hash: dict[str, int] = {}
    instances = []
    small = 0
    for ev in events:
        if ev[0] == "mesh":
            _, scene_index, h, mesh_name, unity_m = ev
            gi = by_hash.get(h)
            if gi is None:
                geom = processed[h]
                if geom is None:
                    by_hash[h] = gi = -1
                else:
                    p, n, idx = geom
                    d = _digest(p, idx)
                    gi = by_digest.get(d)
                    if gi is None:
                        gi = by_digest[d] = len(geoms)
                        geoms.append((mesh_name, p, n, idx, "mesh"))
                        bounds.append((p.min(axis=0), p.max(axis=0)))
                    by_hash[h] = gi
            if gi < 0:
                continue
            m = geometry.to_three_matrix(unity_m)
            if min_prop_size > 0:
                lo, hi = bounds[gi]
                wa = geometry.world_aabb(lo, hi, m)
                if float((wa.max(axis=0) - wa.min(axis=0)).max()) < min_prop_size:
                    small += 1
                    continue
            instances.append((gi, m, scene_index))
        else:
            _, scene_index, tname, (p, n, idx), unity_m = ev
            d = _digest(p, idx)
            gi = by_digest.get(d)
            if gi is None:
                gi = by_digest[d] = len(geoms)
                geoms.append((tname, p, n, idx, "terrain"))
                bounds.append((p.min(axis=0), p.max(axis=0)))
            instances.append((gi, geometry.to_three_matrix(unity_m), scene_index))
    if small:
        print(f"  dropped {small:,} instances below {min_prop_size:g} m")
    source_instance_count = len(instances)

    if prune_min_instances > 0:
        count, size = Counter(), {}
        for gi, m, _ in instances:
            count[gi] += 1
            lo, hi = bounds[gi]
            wa = geometry.world_aabb(lo, hi, m)
            size[gi] = max(size.get(gi, 0.0), float((wa.max(axis=0) - wa.min(axis=0)).max()))
        keep = {gi for gi, c in count.items() if c >= prune_min_instances or size.get(gi, 0.0) >= prune_min_size}
        before = len(instances)
        instances = [inst for inst in instances if inst[0] in keep]
        print(f"  pruned {len(count) - len(keep):,} rare/small mesh types, {before - len(instances):,} instances")

    used = sorted({gi for gi, _, _ in instances})
    if len(used) != len(geoms):
        remap = {old: new for new, old in enumerate(used)}
        geoms = [geoms[i] for i in used]
        instances = [(remap[gi], m, sc) for gi, m, sc in instances]

    write_dataset(out_dir, name, geoms, instances, source_instance_count, levels, scene_paths,
                  profile, mp["label"], mp["tag"])
    print(f"  total time: {time.time() - t0:.1f}s")


def write_dataset(out_dir: Path, name: str, geoms, instances, source_instance_count, levels, scene_paths,
                  profile: str, label: str, tag: str):
    out_dir.mkdir(parents=True, exist_ok=True)
    bin_path = out_dir / f"{name}.bin"
    meta_meshes, local_bounds = [], []
    vertex_total = triangle_total = instanced_triangles = 0

    with open(bin_path, "wb") as f:
        def align(n=4):
            pad = (-f.tell()) % n
            if pad:
                f.write(b"\0" * pad)

        for mesh_name, positions, normals, indices, kind in geoms:
            align(4)
            pos_off = f.tell()
            f.write(positions.astype("<f4").tobytes())
            align(4)
            nrm_off = f.tell()
            # Int8 normals are plenty for untextured lighting (12 -> 3 bytes/vertex).
            f.write(np.clip(np.rint(normals * 127.0), -127, 127).astype(np.int8).tobytes())
            align(4)
            idx_off = f.tell()
            if len(indices) <= 65535:
                idx_type = "uint16"
                f.write(indices.astype("<u2").tobytes())
            else:
                idx_type = "uint32"
                f.write(indices.astype("<u4").tobytes())
            meta_meshes.append({
                "name": mesh_name,
                "kind": kind,
                "terrain": is_terrain(mesh_name, kind),
                "vertexCount": int(len(positions)),
                "indexCount": int(len(indices)),
                "positionOffset": pos_off,
                "normalOffset": nrm_off,
                "normalType": "int8",
                "colorOffset": None,
                "colorType": None,
                "indexOffset": idx_off,
                "indexType": idx_type,
            })
            local_bounds.append((positions.min(axis=0), positions.max(axis=0)))
            vertex_total += len(positions)
            triangle_total += len(indices) // 3

    bounds_min = np.full(3, np.inf)
    bounds_max = np.full(3, -np.inf)
    focus_min = np.full(3, np.inf)
    focus_max = np.full(3, -np.inf)
    out_instances = []
    for gi, m, scene_index in instances:
        lo, hi = local_bounds[gi]
        world = geometry.world_aabb(lo, hi, m)
        wmin, wmax = world.min(axis=0), world.max(axis=0)
        bounds_min = np.minimum(bounds_min, wmin)
        bounds_max = np.maximum(bounds_max, wmax)
        if meta_meshes[gi]["kind"] == "terrain":
            focus_min = np.minimum(focus_min, wmin)
            focus_max = np.maximum(focus_max, wmax)
        out_instances.append({"mesh": gi, "scene": scene_index,
                              "matrix": [round(float(v), 6) for v in m.T.reshape(-1)]})
        instanced_triangles += meta_meshes[gi]["indexCount"] // 3

    if not np.isfinite(focus_min).all():
        # No Unity Terrain (e.g. Streets): robust instance-center bounds so a
        # few huge water/border planes do not dominate the initial camera.
        centers = np.array([m[:3, 3] for _, m, _ in instances])
        focus_min = np.percentile(centers, 1, axis=0) - np.array([150.0, 50.0, 150.0])
        focus_max = np.percentile(centers, 99, axis=0) + np.array([150.0, 50.0, 150.0])

    meta = {
        "map": name,
        "label": label,
        "tag": tag,
        "source": f"Escape from Tarkov / {label} ({tag})",
        "profile": profile,
        "baked": False,
        "chunkSize": 0,
        "chunkCount": 0,
        "scenes": levels,
        "sceneNames": scene_paths,
        "bounds": {"min": [round(float(v), 3) for v in bounds_min], "max": [round(float(v), 3) for v in bounds_max]},
        "focusBounds": {"min": [round(float(v), 3) for v in focus_min],
                        "max": [round(float(v), 3) for v in focus_max]},
        "meshes": meta_meshes,
        "instances": out_instances,
        "stats": {
            "sceneCount": len(levels),
            "meshCount": len(meta_meshes),
            "instanceCount": len(out_instances),
            "sourceInstances": source_instance_count,
            "chunkCount": 0,
            "uniqueVertices": vertex_total,
            "uniqueTriangles": triangle_total,
            "instancedTriangles": instanced_triangles,
        },
    }
    json_path = out_dir / f"{name}.json"
    with open(json_path, "w") as f:
        json.dump(meta, f, separators=(",", ":"))
    print(f"  wrote {bin_path} ({bin_path.stat().st_size / 1e6:.1f} MB), {json_path.name} "
          f"({json_path.stat().st_size / 1e6:.1f} MB)")
    print(f"  {len(meta_meshes):,} meshes, {len(out_instances):,} instances, "
          f"{triangle_total:,} unique / {instanced_triangles:,} instanced triangles")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cache", default=str(cache.DEFAULT_ROOT))
    ap.add_argument("--map", required=True)
    ap.add_argument("--profile", choices=sorted(PROFILES), default="overview")
    ap.add_argument("--include-indoor", action="store_true", help="include *indoor* scenes")
    ap.add_argument("--out", default=None)
    ap.add_argument("--name", default=None)
    ap.add_argument("--lod", type=int, default=None)
    ap.add_argument("--min-prop-size", type=float, default=None)
    ap.add_argument("--decimate-ratio", type=float, default=None)
    ap.add_argument("--decimate-min-tris", type=int, default=200)
    ap.add_argument("--terrain-step", type=int, default=None)
    ap.add_argument("--no-skip", action="store_true", help="keep shadow/decal/background meshes")
    ap.add_argument("--prune-min-instances", type=int, default=0)
    ap.add_argument("--prune-min-size", type=float, default=25.0)
    args = ap.parse_args()

    p = PROFILES[args.profile]
    pick = lambda v, k: p[k] if v is None else v  # noqa: E731
    default_name = args.map if args.profile == "overview" else f"{args.map}-{args.profile}"
    name = args.name or default_name
    out = Path(args.out) if args.out else Path(__file__).resolve().parents[1] / "viewer/public/data" / name
    build(Path(args.cache), args.map, out, name, args.profile,
          lod=pick(args.lod, "lod"),
          min_prop_size=pick(args.min_prop_size, "min_prop_size"),
          decimate_ratio=pick(args.decimate_ratio, "decimate_ratio"),
          decimate_min_tris=args.decimate_min_tris,
          terrain_step=pick(args.terrain_step, "terrain_step"),
          skip_names=p["skip_names"] and not args.no_skip,
          include_indoor=args.include_indoor,
          prune_min_instances=args.prune_min_instances,
          prune_min_size=args.prune_min_size)


if __name__ == "__main__":
    main()
