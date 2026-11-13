"""Map presets: which scenes are extracted for a location, and which of them a build uses.

Two separate choices, because only the first needs the game files:

- `folders`: extraction takes every BuildSettings scene under
  `Assets/Content/Locations/<folder>/` (scripts, AI, culling and all: re-extracting
  later means mounting the game again, keeping a scene in the cache costs little).
  Plus every scene the game's own preset for the location names (`game`, see below).
- `select(scenes, game_presets)`: the build picks its scenes from the cached ones.

The game's presets (`unity.location_presets`, saved in the cache manifest as `gamePresets`)
are what the game loads for a location id. Maps not tuned by hand build from them.

Scenes are identified by path (levelN indices shift between game patches).
`python extract_cache.py --list` shows the BuildSettings scenes by folder.
"""

from __future__ import annotations

import re

CUSTOMS_SCENES = [
    "Assets/Content/Locations/Custom/custom_multiScene.unity",
    "Assets/Content/Locations/Custom/custom_AZS.unity",
    "Assets/Content/Locations/Custom/custom_AZS_old.unity",
    "Assets/Content/Locations/Custom/custom_DesignStuff.unity",
    "Assets/Content/Locations/Custom/custom_Garage.unity",
    "Assets/Content/Locations/Custom/custom_Obshezhitie.unity",
    "Assets/Content/Locations/Custom/custom_Obshezhitie_1_indoor.unity",
    "Assets/Content/Locations/Custom/custom_Obshezhitie_2_indoor.unity",
    "Assets/Content/Locations/Custom/custom_Light.unity",
    "Assets/Content/Locations/Custom/custom_Road.unity",
    "Assets/Content/Locations/Custom/custom_Tamozhnya.unity",
    "Assets/Content/Locations/Custom/custom_Terrain.unity",
    "Assets/Content/Locations/Custom/custom_TrailerPark.unity",
    "Assets/Content/Locations/Custom/custom_factoryStorageZone.unity",
    "Assets/Content/Locations/Custom/custom_mazuto.unity",
    "Assets/Content/Locations/Custom/Custom_Expansion_Temp/custom_Abandoned_Lab.unity",
    "Assets/Content/Locations/Custom/Custom_Expansion_Temp/custom_Abandoned_Plant.unity",
    "Assets/Content/Locations/Custom/Custom_Expansion_Temp/Custom_ChemicalFactory.unity",
    "Assets/Content/Locations/Custom/Custom_Expansion_Temp/Custom_Construction_Factory.unity",
    "Assets/Content/Locations/Custom/Custom_Expansion_Temp/Custom_Expansion.unity",
    "Assets/Content/Locations/Custom/Custom_Expansion_Temp/custom_Pump_Station.unity",
    "Assets/Content/Locations/Custom/Custom_Expansion_Temp/Custom_RepairBox.unity",
    "Assets/Content/Locations/Custom/custom_DesignMain.unity",
]

# Streets of Tarkov: every City scene except scripts/AI/culling/audio/light/
# portal-only scenes. Indoor scenes are extracted; the build decides whether
# to include them.
STREETS_EXCLUDE_RE = re.compile(
    r"City_Scripts|City_AI|City_culling|City_Quests|City_Sound|"
    r"/City_Light/|City_Portals|City_Stencil|City_Grass",
    re.I,
)
INDOOR_RE = re.compile(r"indoor", re.I)


LOCATIONS_PREFIX = "Assets/Content/Locations/"


def location_folder(scene_path: str) -> str | None:
    """`Custom` for Assets/Content/Locations/Custom/..., None outside Locations."""
    if not scene_path.startswith(LOCATIONS_PREFIX):
        return None
    rest = scene_path[len(LOCATIONS_PREFIX):]
    return rest.split("/", 1)[0] if "/" in rest else None


def in_folders(scenes: list[str], folders) -> list[str]:
    folders = {f.lower() for f in folders}
    return [p for p in dict.fromkeys(scenes) if (location_folder(p) or "").lower() in folders]


def _listed(names: list[str]):
    """select: exactly these scenes, in this order (the ones present)."""
    def select(scenes: list[str], game_presets: dict | None = None) -> list[str]:
        have = set(scenes)
        return [p for p in names if p in have]
    select.names = list(names)
    return select


def _streets(all_scenes: list[str], game_presets: dict | None = None) -> list[str]:
    return [p for p in all_scenes if "/Locations/City/" in p and not STREETS_EXCLUDE_RE.search(p)]


# Factory: the Factory_Rework scenes (the Day/Night split matches factory4_day / factory4_night).
# Geometry, background, design and the day lighting scene; not scripts, AI, quests, sound or
# culling. The night lighting scene is left out: the map is one dataset for both variants.
FACTORY_SCENES = [
    "Assets/Content/Locations/Factory_Rework/Factory_Rework_Areas.unity",
    "Assets/Content/Locations/Factory_Rework/Factory_Rework_Main_Building.unity",
    "Assets/Content/Locations/Factory_Rework/Factory_Rework_Basement.unity",
    "Assets/Content/Locations/Factory_Rework/Factory_Rework_Admin_Office.unity",
    "Assets/Content/Locations/Factory_Rework/Factory_Rework_Laboratory.unity",
    "Assets/Content/Locations/Factory_Rework/Factory_Rework_Background.unity",
    "Assets/Content/Locations/Factory_Rework/Factory_Rework_DesignStuff.unity",
    "Assets/Content/Locations/Factory_Rework/Factory_Rework_DesignMain.unity",
    "Assets/Content/Locations/Factory_Rework/Factory_Rework_Day_Light.unity",
]


# A first selection for maps not tuned yet: everything but the scenes that hold no map geometry
# (by the last name token, so `Lighthouse_*` and `*_Light` are kept: Customs' light scene has
# geometry).
NON_GEOMETRY_RE = re.compile(
    r"(^|_)(scripts|ai|ai_high|sound|culling|quests|portals|stencil|stencil_develop|grass|levelborders)$", re.I)


def scene_name(scene_path: str) -> str:
    return scene_path.rsplit("/", 1)[-1].removesuffix(".unity")


def game_preset_scenes(game_presets: dict | None, name: str) -> list[str] | None:
    """Scene paths of the game's preset `name` (a location id, case-insensitive), or None."""
    for server, preset in (game_presets or {}).items():
        if server.lower() == name.lower():
            return [s["path"] for s in preset["scenes"]]
    return None


def _geometry_scenes(game: str, exclude: str | None = None):
    """select: the game preset's scenes (all cached ones without it), except non-geometry
    ones and `exclude` (a regex on the scene name)."""
    extra = re.compile(exclude, re.I) if exclude else None

    def select(scenes: list[str], game_presets: dict | None = None) -> list[str]:
        listed = game_preset_scenes(game_presets, game)
        if listed is not None:
            have = set(scenes)
            scenes = [p for p in listed if p in have]
        return [p for p in scenes if not NON_GEOMETRY_RE.search(scene_name(p))
                and not (extra and extra.search(scene_name(p)))]
    return select


def _untuned(label: str, ids: list[str], folders: list[str], *, game: str | None = None,
             indoor_optional: bool = True, exclude: str | None = None) -> dict:
    game = game or ids[0]
    return {"label": label, "tag": ids[0].upper(), "ids": ids, "indoorOptional": indoor_optional,
            "folders": folders, "game": game, "select": _geometry_scenes(game, exclude), "tuned": False}


# ids: the game's location ids this map is used for (matched case-insensitively
#      by the frontend; written to the dataset's map.json).
# folders: Assets/Content/Locations/<folder>/ scenes to extract.
# select: the scenes a build uses, from the cached ones.
# indoorOptional: the build drops *indoor* scenes unless --include-indoor.
MAPS = {
    "customs": {"label": "Customs", "tag": "BIGMAP", "ids": ["bigmap"], "indoorOptional": False,
                "folders": ["Custom"], "game": "bigmap", "select": _listed(CUSTOMS_SCENES)},
    "streets": {"label": "Streets", "tag": "TARKOVSTREETS", "ids": ["TarkovStreets"], "indoorOptional": True,
                "folders": ["City"], "game": "TarkovStreets", "select": _streets},
    "factory": {"label": "Factory", "tag": "FACTORY4", "ids": ["factory4_day", "factory4_night"], "indoorOptional": False,
                "folders": ["Factory_Rework"], "game": "factory4_day", "select": _listed(FACTORY_SCENES)},
    # Extracted, selection not tuned yet (`tuned: False`). Variants of a location (event, dark,
    # start) are their own presets until a build shows whether they differ from the main one.
    "woods": _untuned("Woods", ["woods"], ["Woods"], indoor_optional=False),
    "shoreline": _untuned("Shoreline", ["shoreline"], ["shorline"]),
    "interchange": _untuned("Interchange", ["interchange"], ["Shopping_Mall"]),
    "reserve": _untuned("Reserve", ["RezervBase"], ["Reserve_Base"], indoor_optional=False),
    "lighthouse": _untuned("Lighthouse", ["Lighthouse"], ["Lighthouse"], indoor_optional=False),
    "ground-zero": _untuned("Ground Zero", ["Sandbox", "Sandbox_high"], ["Sandbox"]),
    "ground-zero-start": _untuned("Ground Zero (start)", ["Sandbox_start"], ["Sandbox_StartLocation"],
                                  game="Sandbox_SL"),
    "labs": _untuned("Labs", ["laboratory", "laboratory_dark"], ["Laboratory"], indoor_optional=False),
    "labs-event": _untuned("Labs (event)", ["laboratory_event"], ["Laboratory_Event"], indoor_optional=False),
    "labyrinth": _untuned("Labyrinth", ["labyrinth"], ["Labyrinth"], indoor_optional=False),
    "terminal": _untuned("Terminal", ["terminal"], ["Terminal"]),
    "icebreaker": _untuned("Icebreaker", ["icebreaker"], ["Icebreaker"], exclude=r"cutscene"),
    "factory-event": _untuned("Factory (event)", ["factory_event"], ["Factory_event"], indoor_optional=False),
}


def extract_scenes(map_name: str, all_scenes: list[str], game_presets: dict | None = None) -> list[str]:
    """The BuildSettings scenes extraction caches for a map: its folders, then whatever else
    its game preset names (Terminal's cutscenes are outside Locations/)."""
    mp = MAPS[map_name]
    out = in_folders(all_scenes, mp["folders"])
    have, listed = set(out), set(all_scenes)
    for p in game_preset_scenes(game_presets, mp.get("game", mp["ids"][0])) or []:
        if p in listed and p not in have:
            have.add(p)
            out.append(p)
    return out
