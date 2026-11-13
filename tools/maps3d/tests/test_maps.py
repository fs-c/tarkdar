"""Map presets: extraction takes whole location folders, the build selects from the cache."""

import unittest
from unittest import mock

import build
from t3d import maps

try:
    from t3d import unity
except ImportError:      # build-only setup without UnityPy
    unity = None

LOC = "Assets/Content/Locations/"


def manifest(map_name, paths, indoor_optional=False):
    keys = {p: f"k{i}" for i, p in enumerate(paths)}
    return {"scenes": {k: {"path": p} for p, k in keys.items()},
            "maps": {map_name: {"label": "X", "tag": "X", "indoorOptional": indoor_optional,
                                "scenes": list(keys.values())}}}


class PresetTest(unittest.TestCase):
    def test_location_folder(self):
        self.assertEqual(maps.location_folder(LOC + "Custom/a.unity"), "Custom")
        self.assertEqual(maps.location_folder(LOC + "Custom/Sub/a.unity"), "Custom")
        self.assertIsNone(maps.location_folder(LOC + "loose.unity"))
        self.assertIsNone(maps.location_folder("Assets/Scenes/Menu.unity"))

    def test_extraction_takes_whole_folders(self):
        scenes = [LOC + "Custom/custom_Scripts.unity", LOC + "custom/odd_case.unity", LOC + "City/c.unity",
                  LOC + "Customs_Other/x.unity", "Assets/Scenes/Menu.unity"]
        self.assertEqual(maps.extract_scenes("customs", scenes), scenes[:2])

    def test_every_preset_selects_within_its_folders(self):
        for name, mp in maps.MAPS.items():
            for p in getattr(mp["select"], "names", []):
                self.assertIn(maps.location_folder(p), mp["folders"], f"{name}: {p}")

    def test_build_selects_from_the_cache(self):
        listed = maps.CUSTOMS_SCENES[:2]
        m = manifest("customs", [listed[1], LOC + "Custom/custom_Scripts.unity", listed[0]])
        with mock.patch.dict(maps.MAPS["customs"], select=maps._listed(listed)):
            keys = build.select_scenes(m, "customs", include_indoor=False)
        self.assertEqual([m["scenes"][k]["path"] for k in keys], listed)   # preset order, scripts left out

    def test_listed_scene_missing_from_cache_fails(self):
        m = manifest("customs", maps.CUSTOMS_SCENES[:1])
        with self.assertRaises(SystemExit):
            build.select_scenes(m, "customs", include_indoor=False)

    def test_indoor_scenes_are_optional_where_the_preset_says(self):
        paths = [LOC + "City/City_A.unity", LOC + "City/City_A_indoor.unity", LOC + "City/City_Scripts.unity"]
        m = manifest("streets", paths)
        self.assertEqual(len(build.select_scenes(m, "streets", include_indoor=False)), 1)
        self.assertEqual(len(build.select_scenes(m, "streets", include_indoor=True)), 2)

    def test_map_without_preset_uses_all_cached_scenes(self):
        m = manifest("experiment", [LOC + "X/a.unity", LOC + "X/b_indoor.unity"], indoor_optional=True)
        self.assertEqual(build.select_scenes(m, "experiment", include_indoor=False), ["k0"])
        with mock.patch.dict(m["maps"]["experiment"], indoorOptional=False):
            self.assertEqual(build.select_scenes(m, "experiment", include_indoor=False), ["k0", "k1"])


def keys(*paths, offline=()):
    return [{"path": LOC + p, "rcid": LOC + p, "_onlyOffline": int(p in offline)} for p in paths]


def preset(name, server, scenes, children=()):
    return {"m_Name": name, "ServerName": server, "_activeSceneName": "", "_scenesResourceKeys": scenes,
            "ChildPresets": [{"m_FileID": 0, "m_PathID": c} for c in children]}


GAME_PRESETS = {"Woods": {"name": "woods.ScenesPreset", "bundle": "woods_preset.bundle", "activeScene": "",
                          "scenes": [{"path": LOC + f"Woods/{n}.unity", "onlyOffline": False}
                                     for n in ("woods_Scripts", "woods_terrain", "woods_combined", "woods_AI")]}}


class GamePresetTest(unittest.TestCase):
    @unittest.skipIf(unity is None, "UnityPy not installed")
    def test_flatten(self):
        out = unity.flatten_presets({
            1: ("factory_day_preset.bundle", preset("factory_day.ScenesPreset", "factory4_day",
                                                    keys("F/day_scripts.unity"), children=[2, 3])),
            2: ("factory_day_preset.bundle", preset("factory_base.ScenesPreset", "",
                                                    keys("F/areas.unity", "F/day_scripts.unity"))),
            # a child with a (wrong) location id of its own is not a location
            3: ("factory_day_preset.bundle", preset("night_culling.ScenesPreset", "factory4_night",
                                                    keys("F/culling.unity", offline=["F/culling.unity"]))),
            # neither is an editor preset
            4: ("customs_preset.bundle", preset("Lighthouse.Editor", "Lighthouse", keys("L/loot.unity"),
                                                children=[6])),
            # ... and its child is still a location
            6: ("lighthouse_preset.bundle", preset("Lighthouse.ScenesPreset", "Lighthouse", keys("L/main.unity"))),
            5: ("x.bundle", preset("Loop.ScenesPreset", "Loop", keys("X/a.unity"), children=[5, 99])),
        })
        self.assertEqual(list(out), ["factory4_day", "Lighthouse", "Loop"])   # sorted ignoring case
        day = out["factory4_day"]
        self.assertEqual([s["path"] for s in day["scenes"]],
                         [LOC + "F/day_scripts.unity", LOC + "F/areas.unity", LOC + "F/culling.unity"])
        self.assertEqual([s["onlyOffline"] for s in day["scenes"]], [False, False, True])
        self.assertEqual(day["bundle"], "factory_day_preset.bundle")
        self.assertEqual(len(out["Loop"]["scenes"]), 1)      # cycles and missing children are harmless

    def test_untuned_map_builds_from_the_game_preset(self):
        cached = [LOC + f"Woods/{n}.unity" for n in ("woods_combined", "woods_light", "woods_terrain", "woods_AI")]
        sel = maps.MAPS["woods"]["select"]
        # game order, only what the game loads, without scripts/AI
        self.assertEqual([maps.scene_name(p) for p in sel(cached, GAME_PRESETS)], ["woods_terrain", "woods_combined"])
        # without game presets (older cache): every cached geometry scene
        self.assertEqual([maps.scene_name(p) for p in sel(cached, None)],
                         ["woods_combined", "woods_light", "woods_terrain"])

    def test_game_preset_lookup_ignores_case(self):
        self.assertEqual(len(maps.game_preset_scenes(GAME_PRESETS, "woods")), 4)
        self.assertIsNone(maps.game_preset_scenes(GAME_PRESETS, "shoreline"))

    def test_extraction_adds_preset_scenes_outside_the_folders(self):
        cutscene = "Assets/Content/Scenes/Terminal_area_PortCutscene.unity"
        presets = {"Terminal": {"scenes": [{"path": LOC + "Terminal/a.unity"}, {"path": cutscene},
                                           {"path": LOC + "Terminal/not_built.unity"}]}}
        all_scenes = [LOC + "Terminal/a.unity", LOC + "Terminal/b.unity", cutscene, "Assets/Other.unity"]
        self.assertEqual(maps.extract_scenes("terminal", all_scenes, presets), all_scenes[:3])

    def test_every_untuned_preset_names_its_game_preset(self):
        for name, mp in maps.MAPS.items():
            self.assertIn("game", mp, name)


if __name__ == "__main__":
    unittest.main()
