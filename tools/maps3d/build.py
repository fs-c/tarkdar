#!/usr/bin/env python3
"""Stage 2: cache/ -> 3D map dataset (format 3, see t3d/dataset.py). No game data needed.

    python build.py --map customs                  # overview -> maps/3d/customs/ (served by the backend)
    python build.py --map customs --error 0.05     # ... with a tighter error bound
    python build.py --map customs --profile reference   # full detail, for the harness only
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
from collections import Counter
from dataclasses import replace
from pathlib import Path
from typing import NamedTuple

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
ALBEDO_SLOTS = ("_MainTex", "_Albedo", "_Aldebo", "_MainTex0", "_Splat0", "_BaseAlbedoASmoothness")
# The rock shaders (every outdoor map) keep their albedo in a slot that caches
# before extractor version 5 have no thumbnail of: a typical rock colour stands in for it.
ROCK_SHADER_RE = re.compile(r"^(ANGRYMESH/PBR Rocks/|MK4/Rock)", re.I)
ROCK_COLOR = (112.0, 108.0, 100.0)


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
    if mean is None and ROCK_SHADER_RE.match(mat.get("shader") or ""):
        mean = ROCK_COLOR
        tint = tint or (mat.get("colors") or {}).get("_BaseColor")
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


class MeshEvent(NamedTuple):
    """A placed renderer that passed the filters of `collect`."""
    scene: int
    hash: str
    name: str
    unity_matrix: np.ndarray
    materials: list[int]       # dataset material ids, -1 where the slot has none
    path: int


class TerrainEvent(NamedTuple):
    """A heightmap terrain that passed the filters of `collect`."""
    scene: int
    name: str
    geom: tuple                # (positions, normals, indices, parts), see geometry.terrain_mesh
    unity_matrix: np.ndarray
    path: int
    colors: np.ndarray | None  # ground colour image from the splat maps
    rect: tuple                # where the colour image lies on the terrain (local x0, z0, x1, z1)


def _terrain_event(a: dict, meta: dict, index: int, scene_index: int, terrain_step: int, tables: Tables):
    """The TerrainEvent of terrain `index` of a scene, or None if its mesh cannot be built."""
    t = meta["terrains"][index]
    heights = a[f"terrain{index}_heights"]
    built = geometry.terrain_mesh(heights, t["scale"], terrain_step)
    if built is None:
        return None
    matrix = np.array(t["matrix"], dtype=np.float64).reshape(4, 4)
    path = tables.path(t["goPath"]) if t.get("goPath") else -1
    # Ground colour from the splat maps; it covers the whole heightmap.
    splat_maps = [a[sm["array"]] for sm in t.get("splatMaps", [])]
    layer_colors = [_layer_color(layer, meta["textures"]) for layer in t.get("layers", [])]
    colors = geometry.terrain_colors(splat_maps, layer_colors)
    columns, rows = heights.shape[::-1]
    width = (columns - 1) * float(t["scale"][0])
    depth = (rows - 1) * float(t["scale"][2])
    rect = (0.0, 0.0, width, -depth)     # local z runs negative in three.js space
    return TerrainEvent(scene_index, f"Terrain_{t['name'] or 'slice'}", built, matrix, path, colors, rect)


def collect(root: Path, scene_keys: list[str], target_lod: int, terrain_step: int, tables: Tables):
    """Pass 1: apply per-renderer filters. Returns ordered events + needed mesh hashes.

    Events: MeshEvent | TerrainEvent
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
            events.append(MeshEvent(scene_index, ref["hash"], ref["name"], np.array(a["r_matrix"][i]), mats, path))
        for ti, t in enumerate(meta["terrains"]):
            if not t["enabled"] or not t["active"]:
                skipped["terrain disabled/inactive"] += 1
                continue
            event = _terrain_event(a, meta, ti, scene_index, terrain_step, tables)
            if event is None:
                skipped["terrain failed"] += 1
            else:
                events.append(event)
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


class GeomRegistry:
    """The dataset's geoms in first-seen order, one per distinct content."""

    def __init__(self):
        self.geoms: list[dataset.Geom] = []
        self._by_digest: dict[bytes, int] = {}

    def register(self, name: str, kind: str, geom: tuple) -> int:
        """Index of the geom with this content (positions, normals, indices, parts), added if new."""
        positions, normals, indices, parts = geom
        digest = _digest(positions, indices, parts)
        index = self._by_digest.get(digest)
        if index is None:
            index = self._by_digest[digest] = len(self.geoms)
            self.geoms.append(dataset.Geom(name, kind, positions, normals, indices, parts))
        return index


def place_instances(events: list, processed: dict, tables: Tables, categories: set[str] | None):
    """Pass 3: events -> (geoms, instances, filtered), geometry registered in first-seen order.

    `filtered` counts the renderers left out for having no slot in `categories`."""
    registry = GeomRegistry()
    by_hash: dict[str, int] = {}      # mesh hash -> geom index, -1 for an unreadable mesh
    instances: list[dataset.Instance] = []
    filtered = 0
    for ev in events:
        if isinstance(ev, MeshEvent):
            geom, dominant = processed[ev.hash]
            index = by_hash.get(ev.hash)
            if index is None:
                index = by_hash[ev.hash] = -1 if geom is None else registry.register(ev.name, "mesh", geom)
            if index < 0:
                continue
            slots = _slots(tables, ev.name, len(registry.geoms[index].parts), ev.materials, dominant)
            if categories is not None and not any(slot.category in categories for slot in slots):
                filtered += 1
                continue
            instances.append(dataset.Instance(index, geometry.to_three_matrix(ev.unity_matrix), ev.scene,
                                              slots, ev.path))
        else:
            index = registry.register(ev.name, "terrain", ev.geom)
            if ev.colors is not None:
                registry.geoms[index].texture, registry.geoms[index].texture_rect = ev.colors, ev.rect
            instances.append(dataset.Instance(index, geometry.to_three_matrix(ev.unity_matrix), ev.scene,
                                              [tables.slot(ev.name, "terrain", -1)], ev.path))
    return registry.geoms, instances, filtered


def drop_unused_geoms(geoms: list, instances: list) -> list:
    """Geoms that no instance uses are removed; instances are renumbered in place."""
    used = sorted({inst.geom for inst in instances})
    if len(used) == len(geoms):
        return geoms
    remap = {old: new for new, old in enumerate(used)}
    for inst in instances:
        inst.geom = remap[inst.geom]
    return [geoms[i] for i in used]


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
        paths = preset["select"].pick(list(key_of), manifest.get("gamePresets"))
        missing = [p for p in preset["select"].required if p not in key_of]
        if missing:
            sys.exit(f"{map_name}: preset scenes not in the cache (re-extract): {missing}")
    indoor_optional = (preset or mp).get("indoorOptional", False)
    if indoor_optional and not include_indoor:
        paths = [p for p in paths if not INDOOR_RE.search(p)]
    return [key_of[p] for p in paths]


INTERIOR_MARGIN = 25.0     # metres around an indoor map's objects that count as the map
BORDERS_RE = re.compile(r"levelborders$", re.I)
BOX_CORNERS = np.array([[x, y, z] for x in (-0.5, 0.5) for y in (-0.5, 0.5) for z in (-0.5, 0.5)])


def level_borders(root: Path, manifest: dict, map_name: str):
    """(min xyz, max xyz), in the renderer's space, of the boxes of the map's *_LevelBorders
    scene: the walls the game puts around the playable area. None if the map has no such scene."""
    lo, hi = np.full(3, np.inf), np.full(3, -np.inf)
    for key in manifest["maps"][map_name]["scenes"]:
        path = manifest["scenes"].get(key, {}).get("path", "")
        if not BORDERS_RE.search(path.removesuffix(".unity")):
            continue
        _, a = cache.read_scene(root, key)
        is_box = np.asarray(a["c_kind"]) == 0
        on = np.asarray(a["c_enabled"], dtype=bool) & np.asarray(a["c_active"], dtype=bool) & is_box
        if not on.any():
            continue
        m = np.asarray(a["c_matrix"], dtype=np.float64)[on]
        local = np.asarray(a["c_center"])[on, None, :] + np.asarray(a["c_size"])[on, None, :] * BOX_CORNERS
        world = (np.einsum("nij,nkj->nki", m[:, :3, :3], local) + m[:, None, :3, 3]).reshape(-1, 3)
        world[:, 2] *= -1.0
        lo, hi = np.minimum(lo, world.min(axis=0)), np.maximum(hi, world.max(axis=0))
    return (lo, hi) if np.isfinite(lo).all() else None


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

    geoms, instances, filtered = place_instances(events, processed, tables, categories)
    if filtered:
        log(f"  dropped {filtered:,} renderers of other categories")
    geoms = drop_unused_geoms(geoms, instances)

    playable = level_borders(root, manifest, map_name) if MAPS.get(map_name, {}).get("borders") else None
    if playable is not None:
        log("  level borders: x {:.0f}..{:.0f}, z {:.0f}..{:.0f}".format(*np.array(playable)[:, [0, 2]].T.reshape(-1)))
    return dataset.Dataset(name=map_name, label=mp["label"], tag=mp["tag"], profile=profile, scenes=scenes,
                           geoms=geoms, instances=instances, materials=tables.materials, paths=tables.paths,
                           playable=playable)


def map_config(map_name: str, label: str) -> dict:
    """map.json of an overview folder: what the backend lists in /maps/index.json."""
    preset = MAPS.get(map_name, {})
    config = {"name": label, "ids": preset.get("ids", [map_name])}
    if preset.get("up"):
        config["up"] = preset["up"]
    return config


def build(root: Path, map_name: str, out_dir: Path, profile: str, *, hlod_options: hlod.Options | None = None,
          **options):
    t0 = time.time()
    interior = bool(MAPS.get(map_name, {}).get("interior"))
    if interior:
        # Everything is kept: the viewer cuts the map open above the floor being looked at.
        options["include_indoor"] = True
        if hlod_options is not None:
            hlod_options = replace(hlod_options, hsr=False)
    ds = assemble(root, map_name, profile, **options)
    if interior and ds.playable is None and ds.instances:
        # No level borders: the building is where nearly everything is. Tight, so the camera frames
        # the building and not the yard around it.
        centers = np.array([inst.matrix[:3, 3] for inst in ds.instances])
        ds.playable = (np.percentile(centers, 1, axis=0) - INTERIOR_MARGIN, np.percentile(centers, 99, axis=0) + INTERIOR_MARGIN)
    if hlod_options is not None:
        ds = hlod.bake(ds, hlod_options)
        ds.build = {"cells": {"size": hlod_options.cell_size, "error": hlod_options.error,
                              "hiddenSurfaceRemoval": hlod_options.hsr}, "interior": interior}
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
