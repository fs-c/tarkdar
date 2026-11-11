import unittest

from . import support  # noqa: F401
from t3d import classify as c


class NameRulesTest(unittest.TestCase):
    def test_tokens_not_substrings(self):
        # HANDOFF invariant 7 and the validation list
        self.assertEqual(c.classify("Treatment_Plant_outdoor_01_LOD0"), "structure")
        self.assertEqual(c.classify("Street_lamp_02"), "structure")
        self.assertEqual(c.classify("Ashtray_01"), "structure")
        self.assertEqual(c.classify("pine01_LOD0"), "foliage")
        self.assertEqual(c.classify("Tree_pine01"), "foliage")
        self.assertEqual(c.classify("plant_wolf_03"), "foliage")
        self.assertEqual(c.classify("birch_12_LOD1"), "foliage")

    def test_leaf_on_hardware_is_not_foliage(self):
        self.assertEqual(c.classify("door_leaf_01"), "structure")
        self.assertEqual(c.classify("leaf_pile"), "foliage")

    def test_water_surface_vs_infrastructure(self):
        for name in ("Water_storage_01_A_LOD0", "water_cooler", "Water_pipe_03", "waterwell_01",
                     "Water_Cleaner_Flotator_Plane_LOD0"):
            self.assertEqual(c.classify(name), "structure", name)
        for name in ("Shoreline_Lake_Water_03_LOD0", "Puddle_atlas_01_LOD0", "water_for_river", "River_part_2"):
            self.assertEqual(c.classify(name), "water", name)

    def test_noise_names(self):
        self.assertEqual(c.classify("fence3_shadow"), "shadow")
        self.assertEqual(c.classify("Wall_Decal_02"), "decal")
        self.assertEqual(c.classify("SkyboxMountains01"), "background")
        self.assertEqual(c.classify("Lenina_57_Background_LOD0"), "background")
        # shadow wins over decal, both win over terrain/water/foliage names
        self.assertEqual(c.classify("tree_decal_shadow"), "shadow")
        self.assertEqual(c.classify("grass_decal"), "decal")

    def test_terrain(self):
        self.assertEqual(c.classify("Terrain_Slice_3_2", "terrain"), "terrain")
        self.assertEqual(c.classify("anything", "terrain", "shadow"), "terrain")
        self.assertEqual(c.classify("custom_terrain_far"), "terrain")
        self.assertEqual(c.classify("Plane02"), "terrain")
        self.assertEqual(c.classify("Plane_wall"), "structure")
        self.assertTrue(c.is_terrain("x", "terrain"))

    def test_empty_name(self):
        self.assertEqual(c.classify(""), "structure")
        self.assertEqual(c.classify(None), "structure")

    def test_skip_regex_matches_noise_only(self):
        self.assertTrue(c.SKIP_NAME_RE.search("mop_SHADOW_LOD2"))
        self.assertFalse(c.SKIP_NAME_RE.search("roof_LOD1"))   # invariant 1: LODs are not skipped by name


class ShaderRulesTest(unittest.TestCase):
    def test_shader_overrides_name(self):
        self.assertEqual(c.classify("garage_wall", shader="shadow"), "shadow")
        self.assertEqual(c.classify("garage_wall", shader="shadow_2sided"), "shadow")
        self.assertEqual(c.classify("road_patch", shader="Decal/Ultra Deferred Decal Of God 3000"), "decal")
        self.assertEqual(c.classify("road_patch", shader="Custom/Vert Paint SoftCutout Decal"), "decal")
        self.assertEqual(c.classify("privet_hedge_LOD1", shader="Nature/SpeedTree8"), "foliage")
        self.assertEqual(c.classify("x", shader="Hidden/Tree Billboard LOD"), "foliage")
        self.assertEqual(c.classify("glass_window", shader="Global Fog/Transparent Reflective Specular"), "glass")
        self.assertEqual(c.classify("City_Glass_239", shader="Custom/Glass2"), "glass")
        self.assertEqual(c.classify("bench_surface", shader="FX/SimpleWater4"), "water")
        self.assertEqual(c.classify("Mountains", shader="Custom/MountainDeferred"), "background")

    def test_water_decal_shader(self):
        shader = "Decal/Water Deferred Decal"
        self.assertEqual(c.classify("Puddle_atlas_01_LOD0", shader=shader), "water")
        self.assertEqual(c.classify("Water_storage_platform_01_decal_LOD0", shader=shader), "decal")
        self.assertEqual(c.classify("decal_plane", shader=shader), "decal")

    def test_plain_shaders_fall_back_to_the_name(self):
        shader = "p0/Reflective/Bumped Specular SMap"
        self.assertEqual(c.classify("roof", shader=shader), "structure")
        self.assertEqual(c.classify("Tree_pine01", shader=shader), "foliage")
        self.assertEqual(c.classify("fence3_shadow", shader=shader), "shadow")
        self.assertEqual(c.classify("Shoreline_Lake_Water_03_LOD0", shader=None), "water")
        self.assertIsNone(c.category_from_shader(shader))
        self.assertIsNone(c.category_from_shader(None))

    def test_flags(self):
        self.assertEqual(c.slot_flags("p0/Reflective/Bumped Specular"), 0)
        self.assertEqual(c.slot_flags(None), 0)
        self.assertEqual(c.slot_flags("p0/Cutout/Bumped Diffuse"), c.FLAG_CUTOUT)
        self.assertEqual(c.slot_flags("Nature/SpeedTreeEFT", 2454), c.FLAG_CUTOUT)
        self.assertEqual(c.slot_flags("Legacy Shaders/Transparent/Cutout/Bumped Diffuse 2 side"), c.FLAG_CUTOUT)
        self.assertEqual(c.slot_flags("p0/Reflective/Bumped Specular SMap Transparent Cutoff"), c.FLAG_CUTOUT)
        self.assertEqual(c.slot_flags("Global Fog/Transparent Reflective Specular", 3000), c.FLAG_TRANSPARENT)
        self.assertEqual(c.slot_flags("Custom/Glass2"), c.FLAG_TRANSPARENT)
        self.assertEqual(c.slot_flags("Standard", 3000), c.FLAG_TRANSPARENT)

    def test_category_ids_are_stable(self):
        # ids are written into datasets; append new categories, never reorder
        self.assertEqual(c.CATEGORIES[:4], ["structure", "terrain", "foliage", "water"])
        self.assertEqual(c.CATEGORY_ID["decal"], c.CATEGORIES.index("decal"))


if __name__ == "__main__":
    unittest.main()
