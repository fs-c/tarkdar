#!/usr/bin/env python3
"""Generate the fixed camera set of a map from its reference dataset (harness/data/).

    ../.venv/bin/python make_views.py customs views/customs.json
    ../.venv/bin/python make_views.py streets views/streets.json

The views are committed, so every candidate dataset of a map is captured from
exactly the same cameras (a candidate's own bounds must not move them):

    top, home          whole map, as the viewer frames it
    area:<group>       45 degrees down onto one scene group
    low:<group>        12 degrees, close: roughly what a zoomed-in user sees

Scene groups are the scene file name, or the City area on Streets. The busiest
groups by structure triangles are used, skipping map-wide ones.
"""

from __future__ import annotations

import json
import math
import re
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from t3d import dataset  # noqa: E402

AREAS = 8
MAX_AREA_RADIUS = 250.0   # larger groups span the map (roads, terrain, multiScene)


def scene_group(path: str) -> str:
    m = re.search(r"City_Areas/([^/]+)", path, re.I)
    if m:
        return m.group(1)
    return re.sub(r"\.unity$", "", path.split("/")[-1], flags=re.I)


def orbit(center, distance, elevation_deg, azimuth_deg):
    el, az = math.radians(elevation_deg), math.radians(azimuth_deg)
    offset = np.array([math.cos(el) * math.sin(az), math.sin(el), math.cos(el) * math.cos(az)]) * distance
    return [round(float(v), 2) for v in center + offset]


def main():
    name, out = sys.argv[1], Path(sys.argv[2])
    index, chunks = dataset.read(HERE / "data" / f"{name}-reference")
    _, a = chunks[0]
    structure = index["categories"].index("structure")

    lo = np.array(index["focusBounds"]["min"])
    hi = np.array(index["focusBounds"]["max"])
    center = (lo + hi) / 2
    radius = float((hi - lo).max())
    views = [
        {"name": "top", "position": [center[0], center[1] + radius * 1.05, center[2] + radius * 0.012],
         "target": center.tolist()},
        {"name": "home", "position": [center[0] + radius * 0.30, center[1] + radius * 0.45,
                                      center[2] + radius * 0.55], "target": center.tolist()},
    ]

    # Structure triangles and instance positions per scene group.
    part_tris = a["part_range"][:, 1] // 3
    inst_mesh = a["inst_mesh"]
    slot_start = a["inst_slot_start"]
    groups: dict[str, dict] = {}
    scene_groups = [scene_group(s["path"]) for s in index["scenes"]]
    positions = a["inst_matrix"][:, 9:12].astype(np.float64)
    for i in range(len(inst_mesh)):
        mesh = int(inst_mesh[i])
        p0, pc = int(a["mesh_part_start"][mesh]), int(a["mesh_part_count"][mesh])
        s0 = int(slot_start[i])
        tris = int(part_tris[p0:p0 + pc][a["slot_category"][s0:s0 + pc] == structure].sum())
        if not tris:
            continue
        g = groups.setdefault(scene_groups[int(a["inst_scene"][i])], {"tris": 0, "points": []})
        g["tris"] += tris
        g["points"].append(positions[i])

    areas = []
    for group, g in groups.items():
        pts = np.array(g["points"])
        c = np.median(pts, axis=0)
        r = float(np.percentile(np.linalg.norm((pts - c)[:, [0, 2]], axis=1), 90))
        if len(pts) >= 50 and r <= MAX_AREA_RADIUS:
            areas.append((g["tris"], group, c, min(max(r, 30.0), 150.0)))
    areas.sort(key=lambda t: (-t[0], t[1]))
    for _, group, c, r in areas[:AREAS]:
        target = [round(float(v), 2) for v in c]
        views.append({"name": f"area:{group}", "position": orbit(c, 2.2 * r, 45, 35), "target": target})
        views.append({"name": f"low:{group}", "position": orbit(c, 1.2 * r, 12, 215), "target": target})

    for v in views:
        v["position"] = [round(float(x), 2) for x in v["position"]]
        v["target"] = [round(float(x), 2) for x in v["target"]]
    doc = {
        "map": name,
        "source": f"{name}-reference",
        "fov": 55,
        "clip": [round(max(0.5, radius / 5000), 3), round(radius * 22, 1)],
        "fog": [round(radius * 0.7, 1), round(radius * 3.2, 1)],
        "views": views,
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, indent=1) + "\n")
    print(f"{out}: {len(views)} views; areas: " + ", ".join(f"{g} (r={r:.0f} m)" for _, g, _, r in areas[:AREAS]))


if __name__ == "__main__":
    main()
