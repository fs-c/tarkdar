#!/usr/bin/env python3
"""Stage 2: cache/ -> viewer dataset (format 2, see t3d/dataset.py). No game data needed.

    python extract/build.py --map customs                          # overview: merged cells
    python extract/build.py --map customs --error 0.05             # ... with a tighter error bound
    python extract/build.py --map customs --profile inspect
    python extract/build.py --map customs --profile explore         # full, unfiltered
    python extract/build.py --map streets --profile explore --include-indoor --lod 1
    python extract/build.py --map customs --profile legacy          # old decimated overview
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

from t3d import cache, dataset, geometry, hlod  # noqa: E402
from t3d.classify import SKIP_NAME_RE, classify, slot_flags  # noqa: E402
from t3d.maps import INDOOR_RE  # noqa: E402

PROFILES = {
    # LOD, min prop size (m), decimation ratio, terrain step, skip noise names
    # overview: cells of merged, error-bounded geometry with hidden surfaces removed
    # (t3d/hlod.py); noise is dropped by category there, not by name.
    "overview": {"lod": 1, "min_prop_size": 0.0, "decimate_ratio": 0.0, "terrain_step": 4, "skip_names": False},
    "inspect": {"lod": 0, "min_prop_size": 0.0, "decimate_ratio": 0.0, "terrain_step": 2, "skip_names": True},
    "explore": {"lod": 0, "min_prop_size": 0.0, "decimate_ratio": 0.0, "terrain_step": 2, "skip_names": False},
    # legacy: the first overview (per-mesh 80 % decimation, 1 m prop cutoff). Kept for comparison.
    "legacy": {"lod": 1, "min_prop_size": 1.0, "decimate_ratio": 0.8, "terrain_step": 4, "skip_names": True},
}

# Texture slots that hold the base colour, in order of preference.
ALBEDO_SLOTS = ("_MainTex", "_Albedo", "_Aldebo", "_MainTex0", "_Splat0")


def _digest(p: np.ndarray, idx: np.ndarray, parts: np.ndarray) -> bytes:
    h = hashlib.blake2b(digest_size=16)
    h.update(p.tobytes())
    h.update(idx.tobytes())
    h.update(parts.tobytes())
    return h.digest()


def material_color(mat: dict, textures: list) -> tuple:
    """Flat base colour of a material: albedo thumbnail mean x _Color (sRGB bytes).

    Alpha 0 means "unknown" (no albedo texture and no _Color)."""
    tint = (mat.get("colors") or {}).get("_Color")
    mean = None
    for slot in ALBEDO_SLOTS:
        ref = (mat.get("textures") or {}).get(slot)
        ti = ref.get("texture") if ref else None
        if ti is not None and 0 <= ti < len(textures) and textures[ti].get("mean"):
            mean = textures[ti]["mean"]
            break
    if mean is None and tint is None:
        return dataset.NO_COLOR
    rgb = np.array(mean[:3] if mean else [255.0, 255.0, 255.0])
    if tint is not None:
        rgb = rgb * np.clip(np.array(tint[:3], dtype=np.float64), 0.0, 1.0)
    r, g, b = (int(v) for v in np.clip(np.rint(rgb), 0, 255))
    return (r, g, b, 255)


class Tables:
    """Dataset-wide material and hierarchy-path tables, deduplicated."""

    def __init__(self):
        self.materials: list[dict] = []
        self.colors: list[tuple] = []
        self.paths: list[str] = []
        self._material_ids: dict = {}
        self._path_ids: dict[str, int] = {}

    def material(self, mat: dict, textures: list) -> int:
        color = material_color(mat, textures)
        key = (mat.get("name"), mat.get("shader"), mat.get("renderQueue"), color)
        mid = self._material_ids.get(key)
        if mid is None:
            mid = self._material_ids[key] = len(self.materials)
            self.materials.append({"name": mat.get("name"), "shader": mat.get("shader"),
                                   "queue": mat.get("renderQueue")})
            self.colors.append(color)
        return mid

    def path(self, text: str) -> int:
        pid = self._path_ids.get(text)
        if pid is None:
            pid = self._path_ids[text] = len(self.paths)
            self.paths.append(text)
        return pid

    def slot(self, mesh_name: str, kind: str, material: int) -> dataset.Slot:
        if material < 0:
            return dataset.Slot(classify(mesh_name, kind))
        m = self.materials[material]
        return dataset.Slot(classify(mesh_name, kind, m["shader"]), slot_flags(m["shader"], m["queue"]),
                            self.colors[material], material)


def collect(root: Path, scene_keys: list[str], target_lod: int, skip_names: bool, terrain_step: int,
            tables: Tables):
    """Pass 1: apply per-renderer filters. Returns ordered events + needed mesh hashes.

    Events: ("mesh", scene, hash, name, unity matrix, material ids, path id)
          | ("terrain", scene, name, geom, unity matrix, path id)
    """
    events = []
    needed = set()
    skipped = Counter()
    scenes = []
    for scene_index, key in enumerate(scene_keys):
        meta, a = cache.read_scene(root, key)
        scenes.append({"level": meta["level"], "path": meta["scenePath"]})
        refs = meta["meshRefs"]
        strings = meta["strings"]
        group_lods = [len(g["heights"]) for g in meta["lodGroups"]]
        material_ids: dict[int, int] = {}   # scene material index -> dataset material id
        n = len(a["r_mesh"])
        # A renderer can be listed in several levels of a LOD group (one mesh
        # reused for LOD0 and LOD1) and in several groups. It is shown when
        # any of its memberships is the level chosen for that group.
        memberships: dict[int, list[tuple[int, int]]] = {}
        for r, g, lvl in a["lod_members"].tolist():
            if r >= 0:
                memberships.setdefault(r, []).append((g, lvl))
        chosen_level = [target_lod if target_lod < count else count - 1 for count in group_lods]
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
            member_of = memberships.get(i)
            if member_of is not None and not any(level == chosen_level[g] for g, level in member_of):
                skipped["other lod"] += 1
                continue
            ref = refs[mi]
            if skip_names and ref["name"] and SKIP_NAME_RE.search(ref["name"]):
                skipped["noise name"] += 1
                continue
            if ref["hash"] is None:
                skipped["unreadable mesh"] += 1
                continue
            start, count = int(a["r_mat_start"][i]), int(a["r_mat_count"][i])
            mats = []
            for local in a["r_material_ref"][start:start + count].tolist():
                if local < 0:
                    mats.append(-1)
                    continue
                mid = material_ids.get(local)
                if mid is None:
                    mid = material_ids[local] = tables.material(meta["materials"][local], meta["textures"])
                mats.append(mid)
            gp = int(a["r_go_path"][i])
            path = tables.path(strings[gp]) if gp >= 0 else -1
            needed.add(ref["hash"])
            events.append(("mesh", scene_index, ref["hash"], ref["name"], np.array(a["r_matrix"][i]), mats, path))
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
            path = tables.path(t["goPath"]) if t.get("goPath") else -1
            events.append(("terrain", scene_index, f"Terrain_{t['name'] or 'slice'}", built, m, path))
        del meta, a
    return events, needed, skipped, scenes


def process_meshes(root: Path, needed: set[str], decimate_ratio: float, decimate_min_tris: int):
    """Pass 2: convert (and optionally decimate) every needed mesh once.

    Returns {hash: (geom or None, index of the largest submesh)}, decimated count.
    """
    store = cache.MeshStore(root)
    out = {}
    decimated = 0
    for mesh in store.iter_meshes(needed):
        geom = geometry.mesh_to_three(mesh)
        if geom is not None and decimate_ratio > 0 and len(geom[2]) // 3 >= decimate_min_tris:
            try:
                geom = geometry.decimate(*geom[:3], decimate_ratio)
                decimated += 1
            except Exception as exc:  # noqa: BLE001
                print(f"    ! decimate {mesh.hash}: {exc}")
        counts = [s[1] for s in mesh.submeshes or []]
        out[mesh.hash] = (geom, int(np.argmax(counts)) if counts else 0)
    return out, decimated


def _slots(tables: Tables, mesh_name: str, part_count: int, mats: list[int], dominant: int) -> list:
    """One slot per part. Submesh k uses material k (Unity repeats the last
    material for extra submeshes). A mesh whose parts were merged takes the
    material of its largest submesh."""
    if not mats:
        return [tables.slot(mesh_name, "mesh", -1)] * part_count
    if part_count == 1:
        return [tables.slot(mesh_name, "mesh", mats[min(dominant, len(mats) - 1)])]
    return [tables.slot(mesh_name, "mesh", mats[min(k, len(mats) - 1)]) for k in range(part_count)]


def assemble(root: Path, map_name: str, name: str, profile: str, *, lod: int, min_prop_size: float,
             decimate_ratio: float, decimate_min_tris: int, terrain_step: int, skip_names: bool,
             include_indoor: bool, prune_min_instances: int = 0, prune_min_size: float = 25.0,
             log=print) -> dataset.Dataset:
    """cache -> in-memory Dataset (all filtering, LOD choice, conversion)."""
    t0 = time.time()
    manifest = cache.load_manifest(root)
    if map_name not in manifest["maps"]:
        sys.exit(f"map {map_name!r} not in cache (have: {', '.join(manifest['maps'])})")
    mp = manifest["maps"][map_name]
    drop_indoor = mp.get("indoorOptional", False) and not include_indoor
    scene_keys = [k for k in mp["scenes"] if not (drop_indoor and INDOOR_RE.search(manifest["scenes"][k]["path"]))]
    log(f"Building {map_name}/{profile} from {len(scene_keys)} cached scenes")

    tables = Tables()
    events, needed, skipped, scenes = collect(root, scene_keys, lod, skip_names, terrain_step, tables)
    t1 = time.time()
    processed, decimated = process_meshes(root, needed, decimate_ratio, decimate_min_tris)
    log(f"  pass 1: {len(events):,} candidates ({t1 - t0:.1f}s); pass 2: {len(processed):,} meshes, "
        f"{decimated:,} decimated ({time.time() - t1:.1f}s)")
    if skipped:
        log("  skipped: " + ", ".join(f"{v:,} {k}" for k, v in skipped.most_common()))

    # Pass 3: register geometry in first-seen order, apply size cutoff.
    geoms: list[dataset.Geom] = []
    bounds = []
    by_digest: dict[bytes, int] = {}
    by_hash: dict[str, int] = {}
    instances: list[dataset.Instance] = []
    small = 0

    def register(geom_name, kind, geom):
        p, n, idx, parts = geom
        d = _digest(p, idx, parts)
        gi = by_digest.get(d)
        if gi is None:
            gi = by_digest[d] = len(geoms)
            geoms.append(dataset.Geom(geom_name, kind, p, n, idx, parts))
            bounds.append((p.min(axis=0), p.max(axis=0)))
        return gi

    for ev in events:
        if ev[0] == "mesh":
            _, scene_index, h, mesh_name, unity_m, mats, path = ev
            geom, dominant = processed[h]
            gi = by_hash.get(h)
            if gi is None:
                gi = by_hash[h] = -1 if geom is None else register(mesh_name, "mesh", geom)
            if gi < 0:
                continue
            m = geometry.to_three_matrix(unity_m)
            if min_prop_size > 0:
                wa = geometry.world_aabb(*bounds[gi], m)
                if float((wa.max(axis=0) - wa.min(axis=0)).max()) < min_prop_size:
                    small += 1
                    continue
            slots = _slots(tables, mesh_name, len(geoms[gi].parts), mats, dominant)
            instances.append(dataset.Instance(gi, m, scene_index, slots, path))
        else:
            _, scene_index, tname, geom, unity_m, path = ev
            gi = register(tname, "terrain", geom)
            instances.append(dataset.Instance(gi, geometry.to_three_matrix(unity_m), scene_index,
                                              [tables.slot(tname, "terrain", -1)], path))
    if small:
        log(f"  dropped {small:,} instances below {min_prop_size:g} m")
    source_instance_count = len(instances)

    if prune_min_instances > 0:
        count, size = Counter(), {}
        for inst in instances:
            count[inst.geom] += 1
            wa = geometry.world_aabb(*bounds[inst.geom], inst.matrix)
            size[inst.geom] = max(size.get(inst.geom, 0.0), float((wa.max(axis=0) - wa.min(axis=0)).max()))
        keep = {gi for gi, c in count.items() if c >= prune_min_instances or size.get(gi, 0.0) >= prune_min_size}
        before = len(instances)
        instances = [inst for inst in instances if inst.geom in keep]
        log(f"  pruned {len(count) - len(keep):,} rare/small mesh types, {before - len(instances):,} instances")

    used = sorted({inst.geom for inst in instances})
    if len(used) != len(geoms):
        remap = {old: new for new, old in enumerate(used)}
        geoms = [geoms[i] for i in used]
        for inst in instances:
            inst.geom = remap[inst.geom]

    return dataset.Dataset(name=name, label=mp["label"], tag=mp["tag"], profile=profile, scenes=scenes,
                           geoms=geoms, instances=instances, materials=tables.materials, paths=tables.paths,
                           source_instances=source_instance_count)


def build(root: Path, map_name: str, out_dir: Path, name: str, profile: str, *,
          hlod_options: hlod.Options | None = None, **options):
    t0 = time.time()
    ds = assemble(root, map_name, name, profile, **options)
    if hlod_options is not None:
        ds = hlod.bake(ds, hlod_options)
        ds.build = {"cells": {"size": hlod_options.cell_size, "error": hlod_options.error,
                              "hiddenSurfaceRemoval": hlod_options.hsr}}
    index = dataset.write(ds, out_dir)
    st = index["stats"]
    size = sum(c["byteLength"] for c in index["chunks"])
    print(f"  wrote {out_dir} ({size / 1e6:.1f} MB geometry)")
    print(f"  {st['meshCount']:,} meshes, {st['instanceCount']:,} instances, "
          f"{st['uniqueTriangles']:,} unique / {st['instancedTriangles']:,} instanced triangles")
    print("  categories: " + ", ".join(f"{c} {v['triangles'] / 1e6:.1f}M" for c, v in st["categories"].items()))
    print(f"  total time: {time.time() - t0:.1f}s")


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
    ap.add_argument("--no-skip", action="store_true", help="inspect/legacy: keep shadow/decal/background meshes")
    ap.add_argument("--prune-min-instances", type=int, default=0)
    ap.add_argument("--prune-min-size", type=float, default=25.0)
    ap.add_argument("--cell-size", type=float, default=hlod.Options.cell_size, help="overview: cell size in metres")
    ap.add_argument("--error", type=float, default=hlod.Options.error,
                    help="overview: simplification error bound in metres")
    ap.add_argument("--no-hsr", action="store_true", help="overview: keep triangles that are never visible")
    ap.add_argument("--workers", type=int, default=0, help="overview: worker processes (default: one per CPU)")
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
          prune_min_size=args.prune_min_size,
          hlod_options=(hlod.Options(cell_size=args.cell_size, error=args.error, hsr=not args.no_hsr,
                                     workers=args.workers) if args.profile == "overview" else None))


if __name__ == "__main__":
    main()
