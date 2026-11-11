"""Map presets: which BuildSettings scenes make up a location.

Scenes are identified by path (levelN indices shift between game patches).
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


def _streets(all_scenes: list[str]) -> list[str]:
    return [p for p in all_scenes if "/Locations/City/" in p and not STREETS_EXCLUDE_RE.search(p)]


# indoorOptional: the build drops *indoor* scenes unless --include-indoor.
MAPS = {
    "customs": {"label": "Customs", "tag": "BIGMAP", "indoorOptional": False,
                "select": lambda scenes: list(CUSTOMS_SCENES)},
    "streets": {"label": "Streets", "tag": "TARKOVSTREETS", "indoorOptional": True,
                "select": _streets},
}
