#!/usr/bin/env python3
"""Stage 1: Unity game files -> cache/ (the only step that needs the game).

Incremental: a scene is skipped when its source files (levelN,
sharedassetsN.assets[.resS]) are unchanged and it was extracted by the same
extractor version. Meshes are flushed to the store every --flush-every scenes;
a scene is only recorded in the manifest after its meshes are flushed, so an
interrupted run resumes cleanly.

    python extract_cache.py --map customs --map streets
    python extract_cache.py --map all
    python extract_cache.py --list          # BuildSettings scenes by location folder

A map's extraction covers whole location folders (`folders` in t3d/maps.py);
which of those scenes a build uses is decided at build time (`select`).
"""

from __future__ import annotations

import argparse
import gc
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from t3d import cache  # noqa: E402
from t3d import maps as maps_mod  # noqa: E402
from t3d.maps import MAPS, extract_scenes, location_folder  # noqa: E402

# Bump when the extractor records something new/different.
# 4: whole location folders; per-scene object type counts (`typeCounts`).
EXTRACTOR_VERSION = 4
DEFAULT_GAME_DIR = "/mnt/win/Battlestate Games/Escape from Tarkov/EscapeFromTarkov_Data"


def source_files(game_dir: Path, level: str) -> dict:
    n = level[len("level"):]
    out = {}
    for name in (level, f"sharedassets{n}.assets", f"sharedassets{n}.assets.resS"):
        p = game_dir / name
        if p.exists():
            st = p.stat()
            out[name] = {"size": st.st_size, "mtime": int(st.st_mtime)}
    return out


def list_scenes(all_scenes: list[str], game_presets: dict) -> None:
    """BuildSettings scenes grouped by location folder, with the preset that extracts each
    folder; then the game's presets (location id -> scenes) and the map that builds each."""
    owner = {f.lower(): name for name, mp in MAPS.items() for f in mp["folders"]}
    groups: dict[str, list[str]] = {}
    for p in all_scenes:
        groups.setdefault(location_folder(p) or "(outside Locations)", []).append(p)
    for folder in sorted(groups, key=str.lower):
        scenes = groups[folder]
        print(f"{folder}  ({len(scenes)} scenes)  -> {owner.get(folder.lower(), '-')}")
        for p in dict.fromkeys(scenes):
            twice = "  (listed twice)" if scenes.count(p) > 1 else ""
            print(f"    level{all_scenes.index(p):<4d} {p}{twice}")
    by_game = {i.lower(): name for name, mp in MAPS.items() for i in mp["ids"]}
    by_game.update({mp["game"].lower(): name for name, mp in MAPS.items()})
    print("\nGame presets (StreamingAssets/Windows/maps):")
    for server, preset in game_presets.items():
        offline = sum(s["onlyOffline"] for s in preset["scenes"])
        print(f"  {server:18s} {len(preset['scenes']):4d} scenes ({offline} offline only)  "
              f"{preset['bundle']:32s} -> {by_game.get(server.lower(), '-')}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--game-dir", default=DEFAULT_GAME_DIR)
    ap.add_argument("--cache", default=str(cache.DEFAULT_ROOT))
    ap.add_argument("--map", action="append", choices=sorted(MAPS) + ["all"])
    ap.add_argument("--list", action="store_true", help="list BuildSettings scenes by location folder and exit")
    ap.add_argument("--only", default=None, help="regex: only (re)extract matching scene paths")
    ap.add_argument("--force", action="store_true", help="re-extract even if unchanged")
    ap.add_argument("--flush-every", type=int, default=25)
    args = ap.parse_args()
    if not args.map and not args.list:
        ap.error("--map or --list is required")
    maps = sorted(MAPS) if "all" in (args.map or []) else list(dict.fromkeys(args.map or []))

    from t3d import unity  # needs UnityPy; imported lazily so build-only setups don't

    game_dir = Path(args.game_dir)
    root = Path(args.cache)
    if not (game_dir / "globalgamemanagers").exists():
        sys.exit(f"game data not found: {game_dir}")

    all_scenes = unity.build_settings_scenes(game_dir)
    if args.list:
        list_scenes(all_scenes, unity.location_presets(game_dir))
        return
    manifest = cache.load_manifest(root)
    # A path can be listed twice (Terminal's scenes are): the first copy has the full
    # sharedassets, the second's only refer to it.
    level_of: dict[str, str] = {}
    for i, p in enumerate(all_scenes):
        level_of.setdefault(p, f"level{i}")
    gg = (game_dir / "globalgamemanagers").stat()
    manifest["source"] = {
        "unityVersion": unity.unity_version(game_dir),
        "globalgamemanagers": {"size": gg.st_size, "mtime": int(gg.st_mtime)},
        "buildSettingsScenes": len(all_scenes),
    }
    manifest["buildSettings"] = all_scenes  # what exists, for choosing scenes without the game
    manifest["gamePresets"] = unity.location_presets(game_dir)  # what the game loads per location
    manifest["extractorVersion"] = EXTRACTOR_VERSION

    todo = []
    for map_name in maps:
        preset = MAPS[map_name]
        scenes = extract_scenes(map_name, all_scenes, manifest["gamePresets"])
        if not scenes:
            sys.exit(f"{map_name}: no BuildSettings scenes in folders {preset['folders']}")
        missing = [p for p in getattr(preset["select"], "names", []) if p not in level_of]
        if missing:
            sys.exit(f"{map_name}: preset scenes not in BuildSettings: {missing}")
        if preset.get("tuned") is False and maps_mod.game_preset_scenes(manifest["gamePresets"], preset["game"]) is None:
            print(f"warning: {map_name}: no game preset {preset['game']!r}; builds will use every folder scene")
        manifest["maps"][map_name] = {
            "label": preset["label"],
            "tag": preset["tag"],
            "indoorOptional": preset["indoorOptional"],
            "scenes": [cache.scene_key(p) for p in scenes],
        }
        todo.extend(p for p in scenes if p not in todo)

    import re
    only = re.compile(args.only, re.I) if args.only else None

    store = cache.MeshStore(root)
    store.discard_staging()
    textures = cache.TextureStore(root)
    extractor = unity.Extractor(game_dir, store, textures)
    pending: list[tuple[str, dict]] = []

    def commit():
        if not pending:
            return
        t = time.time()
        shards = store.flush()
        tex_shards = textures.flush()
        for key, entry in pending:
            manifest["scenes"][key] = entry
        cache.save_manifest(manifest, root)
        print(f"  -- flushed {len(pending)} scenes, {shards} mesh / {tex_shards} texture shards rewritten ({time.time() - t:.1f}s)")
        pending.clear()

    t_all = time.time()
    done = skipped = 0
    for i, path in enumerate(todo):
        key = cache.scene_key(path)
        level = level_of[path]
        sources = source_files(game_dir, level)
        prev = manifest["scenes"].get(key)
        unchanged = (
            prev is not None
            and prev.get("sources") == sources
            and prev.get("extractorVersion") == EXTRACTOR_VERSION
            and cache.scene_file(root, key).exists()
        )
        if (only and not only.search(path)) or (unchanged and not args.force):
            if prev is not None and prev.get("level") != level:
                prev["level"] = level  # same content, renumbered by a patch
            skipped += 1
            continue
        meta, arrays, elapsed = extractor.extract_scene(level, path)
        size = cache.write_scene(root, key, meta, arrays)
        st = meta["stats"]
        print(f"[{i + 1:3d}/{len(todo)}] {key}  ({level}) renderers={st.get('renderers', 0):,} "
              f"refs={len(meta['meshRefs']):,} terrains={len(meta['terrains'])} "
              f"{size / 1e6:.1f} MB  {elapsed:.1f}s  staged={store.staged_bytes / 1e6:.0f} MB")
        if meta["badMeshRefs"]:
            print("      bad mesh refs: " + ", ".join(f"{v}x {k}" for k, v in meta["badMeshRefs"].items()))
        pending.append((key, {
            "path": path,
            "level": level,
            "sources": sources,
            "extractorVersion": EXTRACTOR_VERSION,
            "extractedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "stats": st,
            "typeCounts": meta.get("typeCounts", {}),
        }))
        done += 1
        del meta, arrays
        gc.collect()
        if len(pending) >= args.flush_every or store.staged_bytes > 1.5e9:
            commit()
    commit()
    cache.save_manifest(manifest, root)

    total = sum(p.stat().st_size for p in root.rglob("*.zst"))
    print(f"\nextracted {done} scenes, skipped {skipped} unchanged; "
          f"cache {total / 1e6:.0f} MB; {time.time() - t_all:.0f}s")


if __name__ == "__main__":
    main()
