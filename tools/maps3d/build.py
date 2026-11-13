#!/usr/bin/env python3
"""Stage 2: cache/ -> 3D map dataset (format 2, see t3d/dataset.py). No game data needed.

    python build.py --map customs                  # overview -> maps/3d/customs/ (served by the backend)
    python build.py --map customs --error 0.05     # ... with a tighter error bound
    python build.py --map customs --profile reference   # full detail, for the harness only
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

from t3d import cache, dataset, geometry, ground, hlod  # noqa: E402
from t3d.classify import classify, slot_flags  # noqa: E402
from t3d.maps import INDOOR_RE, MAPS  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
MAPS_ROOT = REPO / "maps" / "3d"                                   # overview datasets, one folder per map
REFERENCE_ROOT = Path(__file__).resolve().parent / "harness" / "data"   # reference datasets (harness)

PROFILES = {
    # overview: what the radar shows. Cells of merged, error-bounded geometry
    # with hidden surfaces removed (t3d/hlod.py).
    "overview": {"lod": 1, "terrain_step": 4},
    # reference: the quality bar the harness compares against. Every renderer at
    # full detail, restricted to the categories the overview is judged on.
    "reference": {"lod": 0, "terrain_step": 2},
}
REFERENCE_CATEGORIES = {"structure", "terrain", "water", "glass", "road"}

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


def _layer_color(layer: dict, textures: list):
    """Mean colour of a terrain layer's diffuse texture, or None."""
    ref = layer.get("diffuse")
    if isinstance(ref, int):
        ref = textures[ref] if 0 <= ref < len(textures) else None
    if isinstance(ref, dict):
        ref = ref.get("mean")
    return ref if isinstance(ref, (list, tuple)) and len(ref) >= 3 else None


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


def collect(root: Path, scene_keys: list[str], target_lod: int, terrain_step: int, tables: Tables):
    """Pass 1: apply per-renderer filters. Returns ordered events + needed mesh hashes.

    Events: ("mesh", scene, hash, name, unity matrix, material ids, path id)
          | ("terrain", scene, name, geom, unity matrix, path id, colour image, its rect)
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
            # Ground colour from the splat maps; it covers the whole heightmap.
            colors = geometry.terrain_colors([a[sm["array"]] for sm in t.get("splatMaps", [])],
                                             [_layer_color(layer, meta["textures"]) for layer in t.get("layers", [])])
            size = (np.array(heights.shape[::-1]) - 1) * np.array([t["scale"][0], t["scale"][2]], dtype=np.float64)
            rect = (0.0, 0.0, float(size[0]), -float(size[1]))     # local z runs negative in three.js space
            events.append(("terrain", scene_index, f"Terrain_{t['name'] or 'slice'}", built, m, path, colors, rect))
        del meta, a
    return events, needed, skipped, scenes


def process_meshes(root: Path, needed: set[str]):
    """Pass 2: convert every needed mesh once.

    Returns {hash: (geom or None, index of the largest submesh)}.
    """
    store = cache.MeshStore(root)
    out = {}
    for mesh in store.iter_meshes(needed):
        counts = [s[1] for s in mesh.submeshes or []]
        out[mesh.hash] = (geometry.mesh_to_three(mesh), int(np.argmax(counts)) if counts else 0)
    return out


def _slots(tables: Tables, mesh_name: str, part_count: int, mats: list[int], dominant: int) -> list:
    """One slot per part. Submesh k uses material k (Unity repeats the last
    material for extra submeshes). A mesh whose parts were merged takes the
    material of its largest submesh."""
    if not mats:
        return [tables.slot(mesh_name, "mesh", -1)] * part_count
    if part_count == 1:
        return [tables.slot(mesh_name, "mesh", mats[min(dominant, len(mats) - 1)])]
    return [tables.slot(mesh_name, "mesh", mats[min(k, len(mats) - 1)]) for k in range(part_count)]


def select_scenes(manifest: dict, map_name: str, include_indoor: bool) -> list[str]:
    """The cached scenes (keys) a build of `map_name` uses.

    Extraction caches whole location folders; the preset's `select` picks from them. A map
    without a preset (tests, experiments) uses every scene cached for it."""
    mp = manifest["maps"][map_name]
    preset = MAPS.get(map_name)
    key_of = {manifest["scenes"][k]["path"]: k for k in mp["scenes"] if k in manifest["scenes"]}
    if preset is None:
        paths = list(key_of)
    else:
        paths = preset["select"](list(key_of), manifest.get("gamePresets"))
        missing = [p for p in getattr(preset["select"], "names", []) if p not in key_of]
        if missing:
            sys.exit(f"{map_name}: preset scenes not in the cache (re-extract): {missing}")
    indoor_optional = (preset or mp).get("indoorOptional", False)
    if indoor_optional and not include_indoor:
        paths = [p for p in paths if not INDOOR_RE.search(p)]
    return [key_of[p] for p in paths]


def assemble(root: Path, map_name: str, profile: str, *, lod: int, terrain_step: int, include_indoor: bool,
             categories: set[str] | None = None, log=print) -> dataset.Dataset:
    """cache -> in-memory Dataset (LOD choice, classification, conversion).

    `categories`: keep only renderers that have a material slot in one of them."""
    t0 = time.time()
    manifest = cache.load_manifest(root)
    if map_name not in manifest["maps"]:
        sys.exit(f"map {map_name!r} not in cache (have: {', '.join(manifest['maps'])})")
    mp = manifest["maps"][map_name]
    scene_keys = select_scenes(manifest, map_name, include_indoor)
    log(f"Building {map_name}/{profile} from {len(scene_keys)} cached scenes")

    tables = Tables()
    events, needed, skipped, scenes = collect(root, scene_keys, lod, terrain_step, tables)
    t1 = time.time()
    processed = process_meshes(root, needed)
    log(f"  pass 1: {len(events):,} candidates ({t1 - t0:.1f}s); pass 2: {len(processed):,} meshes "
        f"({time.time() - t1:.1f}s)")
    if skipped:
        log("  skipped: " + ", ".join(f"{v:,} {k}" for k, v in skipped.most_common()))

    # Pass 3: register geometry in first-seen order.
    geoms: list[dataset.Geom] = []
    bounds = []
    by_digest: dict[bytes, int] = {}
    by_hash: dict[str, int] = {}
    instances: list[dataset.Instance] = []
    filtered = 0

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
            slots = _slots(tables, mesh_name, len(geoms[gi].parts), mats, dominant)
            if categories is not None and not any(slot.category in categories for slot in slots):
                filtered += 1
                continue
            instances.append(dataset.Instance(gi, geometry.to_three_matrix(unity_m), scene_index, slots, path))
        else:
            _, scene_index, tname, geom, unity_m, path, colors, rect = ev
            gi = register(tname, "terrain", geom)
            if colors is not None:
                geoms[gi].texture, geoms[gi].texture_rect = colors, rect
            instances.append(dataset.Instance(gi, geometry.to_three_matrix(unity_m), scene_index,
                                              [tables.slot(tname, "terrain", -1)], path))
    if filtered:
        log(f"  dropped {filtered:,} renderers of other categories")

    used = sorted({inst.geom for inst in instances})
    if len(used) != len(geoms):
        remap = {old: new for new, old in enumerate(used)}
        geoms = [geoms[i] for i in used]
        for inst in instances:
            inst.geom = remap[inst.geom]

    return dataset.Dataset(name=map_name, label=mp["label"], tag=mp["tag"], profile=profile, scenes=scenes,
                           geoms=geoms, instances=instances, materials=tables.materials, paths=tables.paths)


def map_config(map_name: str, label: str) -> dict:
    """map.json of an overview folder: what the backend lists in /maps/index.json."""
    preset = MAPS.get(map_name, {})
    return {"name": label, "ids": preset.get("ids", [map_name])}


def build(root: Path, map_name: str, out_dir: Path, profile: str, *, hlod_options: hlod.Options | None = None,
          **options):
    t0 = time.time()
    ds = assemble(root, map_name, profile, **options)
    if hlod_options is not None:
        ds = hlod.bake(ds, hlod_options)
        ds.build = {"cells": {"size": hlod_options.cell_size, "error": hlod_options.error,
                              "hiddenSurfaceRemoval": hlod_options.hsr}}
        # After the bake: hidden surfaces are gone, so what is left is what a viewer sees from above.
        ds.ground = ground.of_dataset(ds, dataset.focus_bounds(ds))
        if ds.ground is not None:
            rows, columns = ds.ground.heights.shape
            print(f"  ground map: {columns} x {rows} cells of {ds.ground.cell:g} m, "
                  f"{ds.ground.building.mean() * 100:.0f} % under buildings")
    index = dataset.write(ds, out_dir)
    if profile == "overview":
        (out_dir / "map.json").write_text(json.dumps(map_config(map_name, ds.label), indent=2) + "\n")
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
    ap.add_argument("--out", default=None, help="output directory (default: maps/3d/<map>, or the harness data folder)")
    ap.add_argument("--lod", type=int, default=None)
    ap.add_argument("--terrain-step", type=int, default=None)
    ap.add_argument("--cell-size", type=float, default=hlod.Options.cell_size, help="overview: cell size in metres")
    ap.add_argument("--error", type=float, default=hlod.Options.error,
                    help="overview: simplification error bound in metres")
    ap.add_argument("--no-hsr", action="store_true", help="overview: keep triangles that are never visible")
    ap.add_argument("--workers", type=int, default=0, help="overview: worker processes (default: one per CPU)")
    args = ap.parse_args()

    p = PROFILES[args.profile]
    overview = args.profile == "overview"
    default_out = MAPS_ROOT / args.map if overview else REFERENCE_ROOT / f"{args.map}-reference"
    build(Path(args.cache), args.map, Path(args.out) if args.out else default_out, args.profile,
          lod=p["lod"] if args.lod is None else args.lod,
          terrain_step=p["terrain_step"] if args.terrain_step is None else args.terrain_step,
          include_indoor=args.include_indoor,
          categories=None if overview else REFERENCE_CATEGORIES,
          hlod_options=(hlod.Options(cell_size=args.cell_size, error=args.error, hsr=not args.no_hsr,
                                     workers=args.workers) if overview else None))


if __name__ == "__main__":
    main()
