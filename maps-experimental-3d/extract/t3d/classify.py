"""Name-based mesh classification (token rules, see HANDOFF invariants)."""

from __future__ import annotations

import re

# Cosmetic/noise geometry skipped by default in non-explore builds.
# LOD selection already filters LOD groups; do not skip _LOD1/_LOD2 meshes by name.
SKIP_NAME_RE = re.compile(r"shadow|decal|skybox|background|backdrop", re.I)
TERRAIN_NAME_RE = re.compile(r"^terrain_|^custom_terrain|^plane\d*$|^plane_lod", re.I)

WATER_TOKENS = {"water", "river", "lake", "puddle", "pond", "sea", "ocean", "swamp"}
WATER_STRUCTURAL_TOKENS = {
    "pipe", "pipes", "tank", "cistern", "storage", "filter", "facility",
    "cooler", "mixer", "cleaner", "well", "crane", "platform", "railings",
    "sump", "sewage", "window", "flotator", "decal",
}
FOLIAGE_TOKENS = {
    "tree", "pine", "birch", "ash", "filbert", "grass", "bush", "kust",
    "derevo", "foliage", "leaf", "oak", "maple", "willow", "poplar",
    "spruce", "fir", "elm", "linden", "cedar", "juniper", "shrub",
    "fern", "reed", "ivy",
}
HARDWARE_TOKENS = {
    "window", "windows", "glass", "door", "doors", "gate", "gates",
    "shutter", "shutters", "table", "tables", "locker", "cabinet",
}


def _tokens(lower: str) -> list[str]:
    return [t for t in re.split(r"[^a-z0-9]+", lower) if t]


def is_water(name: str) -> bool:
    """Water surfaces vs water infrastructure (pipes, tanks, coolers, wells)."""
    lower = (name or "").lower()
    if "waterwell" in lower:
        return False
    if "water_for" in lower:
        return True
    tokens = _tokens(lower)
    if any(t in WATER_STRUCTURAL_TOKENS for t in tokens):
        return False
    return any(t in WATER_TOKENS for t in tokens) or lower.startswith("waterfor")


def is_foliage(name: str) -> bool:
    """Whole-token vegetation match, or token prefix + digits (pine01, tree02)."""
    lower = (name or "").lower()
    if lower.startswith("plant_wolf") or "_plant_wolf" in lower:
        return True
    tokens = _tokens(lower)
    hardware = any(t in HARDWARE_TOKENS for t in tokens)
    for tok in tokens:
        for veg in FOLIAGE_TOKENS:
            if tok == veg or (tok.startswith(veg) and tok[len(veg):].isdigit()):
                if veg == "leaf" and hardware:
                    continue
                return True
    return False


def is_terrain(name: str, kind: str = "mesh") -> bool:
    return kind == "terrain" or bool(TERRAIN_NAME_RE.search(name or ""))
