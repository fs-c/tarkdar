"""Classification of renderers into viewer categories.

The single classifier of the project: the build writes its result into the
dataset, the viewer only reads it. Shader names decide where they are
unambiguous (shadow proxies, decals, SpeedTree, water, glass); mesh-name token
rules (see HANDOFF invariants) cover the rest.
"""

from __future__ import annotations

import re

# Order is the dataset's category id (index into the "categories" header list).
CATEGORIES = ["structure", "terrain", "foliage", "water", "glass", "shadow", "decal", "background"]
CATEGORY_ID = {name: i for i, name in enumerate(CATEGORIES)}

# Per-slot flags (bit set).
FLAG_CUTOUT = 1        # alpha-tested: the mesh is a card, the silhouette lives in the texture
FLAG_TRANSPARENT = 2   # alpha-blended

TERRAIN_NAME_RE = re.compile(r"^terrain_|^custom_terrain|^plane\d*$|^plane_lod", re.I)
SHADOW_NAME_RE = re.compile(r"shadow", re.I)
DECAL_NAME_RE = re.compile(r"decal", re.I)
BACKGROUND_NAME_RE = re.compile(r"background|backdrop|skybox", re.I)

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

# Shader-name rules (lower-cased shader name).
WATER_DECAL_SHADER = "decal/water deferred decal"
FOLIAGE_SHADER_RE = re.compile(r"speedtree|tree billboard")
WATER_SHADER_RE = re.compile(r"water")
GLASS_SHADER_RE = re.compile(r"glass|transparent reflective|depthzwritedithered")
BACKGROUND_SHADER_RE = re.compile(r"mountaindeferred|skybox")
CUTOUT_SHADER_RE = re.compile(r"cutout|cutoff|speedtree|tree billboard")
TRANSPARENT_QUEUE = 3000


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


def category_from_name(name: str, kind: str = "mesh") -> str:
    """Mesh-name rules only (the pre-shader classifier; also the fallback)."""
    name = name or ""
    if kind == "terrain":
        return "terrain"
    if SHADOW_NAME_RE.search(name):
        return "shadow"
    if DECAL_NAME_RE.search(name):
        return "decal"
    if BACKGROUND_NAME_RE.search(name):
        return "background"
    if TERRAIN_NAME_RE.search(name):
        return "terrain"
    if is_water(name):
        return "water"
    if is_foliage(name):
        return "foliage"
    return "structure"


def category_from_shader(shader: str | None, name: str = "") -> str | None:
    """Category implied by the shader alone, or None when it says nothing."""
    if not shader:
        return None
    lower = shader.lower()
    if lower.startswith("shadow"):
        return "shadow"
    if lower == WATER_DECAL_SHADER:
        # Puddles are drawn as water decals; wet stains on tanks are decals.
        return "water" if is_water(name) else "decal"
    if "decal" in lower:
        return "decal"
    if FOLIAGE_SHADER_RE.search(lower):
        return "foliage"
    if WATER_SHADER_RE.search(lower):
        return "water"
    if GLASS_SHADER_RE.search(lower):
        return "glass"
    if BACKGROUND_SHADER_RE.search(lower):
        return "background"
    return None


def classify(name: str, kind: str = "mesh", shader: str | None = None) -> str:
    """Category of one material slot of a renderer."""
    if kind == "terrain":
        return "terrain"
    return category_from_shader(shader, name) or category_from_name(name, kind)


def slot_flags(shader: str | None, render_queue: int | None = None) -> int:
    lower = (shader or "").lower()
    flags = 0
    if CUTOUT_SHADER_RE.search(lower):
        flags |= FLAG_CUTOUT
    blended = "transparent" in lower and not flags & FLAG_CUTOUT
    if blended or GLASS_SHADER_RE.search(lower) or (render_queue or 0) >= TRANSPARENT_QUEUE:
        flags |= FLAG_TRANSPARENT
    return flags
