"""Build stage over a synthetic cache, the dataset writer, and (when the real
cache is present) the HANDOFF validation checks."""

import tempfile
import unittest
from pathlib import Path

import numpy as np

from . import support
from .support import named, quad_mesh, translation, write_cache
import build
import compare_datasets
from t3d import dataset
from t3d.classify import CATEGORIES, FLAG_CUTOUT

OPAQUE = {"name": "wall", "shader": "p0/Reflective/Bumped Specular", "renderQueue": -1,
          "colors": {"_Color": [0.5, 1.0, 2.0, 1.0]}, "textures": {"_MainTex": {"texture": 0}}}
DECAL = {"name": "stain", "shader": "Decal/Ultra Deferred Decal Of God 3000", "renderQueue": 2005,
         "colors": {}, "textures": {}}
CUTOUT = {"name": "wire", "shader": "p0/Cutout/Bumped Diffuse", "renderQueue": 2450,
          "colors": {"_Color": [1.0, 1.0, 1.0, 1.0]}, "textures": {}}

EXPLORE = dict(lod=0, min_prop_size=0.0, decimate_ratio=0.0, decimate_min_tris=200, terrain_step=1,
               skip_names=False, include_indoor=True)


def assemble(root, **overrides):
    return build.assemble(Path(root), "test", "test", "explore", **{**EXPLORE, **overrides}, log=lambda *_: None)


def categories(ds):
    return [[s.category for s in inst.slots] for inst in ds.instances]


class SyntheticBuildTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def test_instances_slots_and_tables(self):
        wall = named(quad_mesh(2.0, [[0, 3, 0], [3, 3, 0]]), "wall_LOD0")
        write_cache(self.root, [
            {"mesh": 0, "matrix": translation(10, 0, 5), "materials": [0, 1], "path": "root/wall_a"},
            {"mesh": 0, "matrix": translation(20, 0, 5), "materials": [0], "path": "root/wall_b"},
            {"mesh": 0, "materials": [], "path": "root/wall_c"},
        ], meshes=[wall], materials=[OPAQUE, DECAL])
        ds = assemble(self.root)
        self.assertEqual(len(ds.geoms), 1)
        self.assertEqual(ds.geoms[0].name, "wall_LOD0")
        np.testing.assert_array_equal(ds.geoms[0].parts, [[0, 3], [3, 3]])
        # slot k -> material k; Unity repeats the last material; none -> name rules
        self.assertEqual(categories(ds), [["structure", "decal"], ["structure", "structure"],
                                          ["structure", "structure"]])
        self.assertEqual([s.material for s in ds.instances[0].slots], [0, 1])
        self.assertEqual([s.material for s in ds.instances[2].slots], [-1, -1])
        # colour = albedo mean (100, 150, 200) x _Color clamped to 1
        self.assertEqual(ds.instances[0].slots[0].color, (50, 150, 200, 255))
        self.assertEqual(ds.instances[0].slots[1].color, dataset.NO_COLOR)
        self.assertEqual(ds.materials[1], {"name": "stain", "shader": DECAL["shader"], "queue": 2005})
        self.assertEqual([ds.paths[i.path] for i in ds.instances], ["root/wall_a", "root/wall_b", "root/wall_c"])
        self.assertEqual(ds.scenes, [{"level": "level1", "path": "Assets/Content/Locations/Test/test_scene.unity"}])
        # Unity (10, 0, 5) -> three.js (10, 0, -5)
        np.testing.assert_array_equal(ds.instances[0].matrix[:3, 3], [10, 0, -5])

    def test_renderer_filters(self):
        mesh = named(quad_mesh(), "box")
        write_cache(self.root, [
            {"mesh": 0, "path": "kept"},
            {"mesh": 0, "enabled": False},
            {"mesh": 0, "active": False},
            {"mesh": -1},
        ], meshes=[mesh])
        ds = assemble(self.root)
        self.assertEqual([ds.paths[i.path] for i in ds.instances], ["kept"])

    def test_lod_selection(self):
        meshes = [named(quad_mesh(1.0), "box_LOD0"), named(quad_mesh(2.0), "box_LOD1"),
                  named(quad_mesh(3.0), "lone_LOD1")]
        renderers = [{"mesh": 0, "path": "lod0"}, {"mesh": 1, "path": "lod1"},
                     {"mesh": 2, "path": "ungrouped"}, {"mesh": 0, "path": "single-level"}]
        groups = [{"heights": [0.5, 0.1]}, {"heights": [0.5]}]
        members = [[0, 0, 0], [1, 0, 1], [3, 1, 0]]
        write_cache(self.root, renderers, meshes=meshes, lod_groups=groups, lod_members=members)
        names = lambda ds: [ds.paths[i.path] for i in ds.instances]  # noqa: E731
        # invariant 1: a renderer outside any LOD group is kept whatever its name
        self.assertEqual(names(assemble(self.root, lod=0)), ["lod0", "ungrouped", "single-level"])
        # a group with fewer levels falls back to its last level
        self.assertEqual(names(assemble(self.root, lod=1)), ["lod1", "ungrouped", "single-level"])

    def test_renderer_in_several_lod_levels(self):
        # invariant 3: one renderer reused for two levels is shown at both
        # (the old "last membership wins" rule dropped it at one of them)
        write_cache(self.root, [{"mesh": 0, "path": "shared"}, {"mesh": 0, "path": "far"}],
                    meshes=[named(quad_mesh(), "box")], lod_groups=[{"heights": [0.5, 0.2, 0.1]}],
                    lod_members=[[0, 0, 0], [0, 0, 1], [1, 0, 2]])
        names = lambda ds: [ds.paths[i.path] for i in ds.instances]  # noqa: E731
        self.assertEqual(names(assemble(self.root, lod=0)), ["shared"])
        self.assertEqual(names(assemble(self.root, lod=1)), ["shared"])
        self.assertEqual(names(assemble(self.root, lod=2)), ["far"])

    def test_renderer_in_several_lod_groups(self):
        # shown when the chosen level of any of its groups lists it
        write_cache(self.root, [{"mesh": 0, "path": "r"}], meshes=[named(quad_mesh(), "box")],
                    lod_groups=[{"heights": [0.5, 0.1]}, {"heights": [0.5]}], lod_members=[[0, 0, 1], [0, 1, 0]])
        self.assertEqual(len(assemble(self.root, lod=0).instances), 1)   # via group 1 (single level)
        self.assertEqual(len(assemble(self.root, lod=1).instances), 1)

    def test_skip_names_and_min_size(self):
        meshes = [named(quad_mesh(4.0), "wall"), named(quad_mesh(4.0, z=1.0), "wall_shadow"),
                  named(quad_mesh(0.5), "bolt")]
        write_cache(self.root, [{"mesh": 0}, {"mesh": 1}, {"mesh": 2}], meshes=meshes)
        self.assertEqual([g.name for g in assemble(self.root).geoms], ["wall", "wall_shadow", "bolt"])
        self.assertEqual([g.name for g in assemble(self.root, skip_names=True).geoms], ["wall", "bolt"])
        ds = assemble(self.root, min_prop_size=1.0)
        self.assertEqual([g.name for g in ds.geoms], ["wall", "wall_shadow"])
        self.assertEqual([i.geom for i in ds.instances], [0, 1])

    def test_identical_geometry_is_shared(self):
        a, b = named(quad_mesh(), "a"), named(quad_mesh(), "b")
        b.hash = "ab" + "0" * 30   # same vertices under another hash (e.g. different UVs)
        write_cache(self.root, [{"mesh": 0}, {"mesh": 1}], meshes=[a, b])
        ds = assemble(self.root)
        self.assertEqual(len(ds.geoms), 1)
        self.assertEqual([i.geom for i in ds.instances], [0, 0])

    def test_merged_parts_use_the_largest_submesh_material(self):
        mesh = named(quad_mesh(1.0, [[0, 3, 0], [3, 3, 1]]), "wire")   # irregular -> one part
        mesh.submeshes = [[0, 2, 0], [2, 4, 0]]
        write_cache(self.root, [{"mesh": 0, "materials": [0, 1]}], meshes=[mesh], materials=[OPAQUE, CUTOUT])
        ds = assemble(self.root)
        (slot,) = ds.instances[0].slots
        self.assertEqual(ds.materials[slot.material]["name"], "wire")
        self.assertEqual(slot.flags, FLAG_CUTOUT)
        self.assertEqual(slot.color, (255, 255, 255, 255))

    def test_terrain(self):
        terrain = {"enabled": True, "active": True, "name": "Slice", "goPath": "terrain/Slice",
                   "scale": [1.0, 100.0, 1.0], "matrix": translation(5, 0, 7).reshape(-1).tolist()}
        write_cache(self.root, [], meshes=[], terrains=[terrain, {**terrain, "enabled": False}],
                    terrain_arrays={"terrain0_heights": np.zeros((3, 3), dtype=np.int16),
                                    "terrain1_heights": np.zeros((3, 3), dtype=np.int16)})
        ds = assemble(self.root)
        self.assertEqual([(g.name, g.kind) for g in ds.geoms], [("Terrain_Slice", "terrain")])
        self.assertEqual(categories(ds), [["terrain"]])
        np.testing.assert_array_equal(ds.instances[0].matrix[:3, 3], [5, 0, -7])

    def test_unknown_map(self):
        write_cache(self.root, [], meshes=[])
        with self.assertRaises(SystemExit):
            build.assemble(self.root, "nope", "nope", "explore", **EXPLORE)


class DatasetFormatTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        big = named(quad_mesh(3.0), "big")
        big.positions = np.concatenate([big.positions, np.zeros((70000, 3), dtype=np.float32)])   # > 65536 vertices
        big.hash = "cd" + "0" * 30
        write_cache(self.root / "cache", [
            {"mesh": 0, "matrix": translation(10, 0, 5), "materials": [0, 1], "path": "a"},
            {"mesh": 1, "materials": [0], "path": "b"},
        ], meshes=[named(quad_mesh(2.0, [[0, 3, 0], [3, 3, 0]]), "wall"), big], materials=[OPAQUE, DECAL])
        self.ds = assemble(self.root / "cache")

    def test_write_read(self):
        out = self.root / "out"
        (out).mkdir()
        (out / "stale.t3d").write_bytes(b"old")
        dataset.write(self.ds, out)
        self.assertEqual(sorted(p.name for p in out.iterdir()), ["chunk-0.t3d", "index.json", "sources.json"])
        index, chunks, sources = dataset.read(out)
        self.assertEqual(index["format"], 2)
        self.assertEqual(index["categories"], CATEGORIES)
        self.assertEqual(index["chunks"][0]["byteLength"], (out / "chunk-0.t3d").stat().st_size)
        self.assertEqual(index["stats"]["instanceCount"], 2)
        self.assertEqual(index["stats"]["uniqueTriangles"], 4)
        self.assertEqual(index["stats"]["categories"],
                         {"structure": {"slots": 2, "triangles": 3}, "decal": {"slots": 1, "triangles": 1}})
        self.assertEqual(index["bounds"], {"min": [0.0, 0.0, -5.0], "max": [12.0, 3.0, 0.0]})
        self.assertEqual(sources, {"paths": ["a", "b"]})

        meta, a = chunks[0]
        self.assertEqual(meta["kind"], "instanced")
        self.assertEqual(meta["meshNames"], ["wall", "big"])
        np.testing.assert_array_equal(a["mesh_vertex_start"], [0, 4])
        np.testing.assert_array_equal(a["mesh_index_wide"], [0, 1])
        np.testing.assert_array_equal(a["mesh_index_start"], [0, 0])   # separate 16/32-bit index arrays
        np.testing.assert_array_equal(a["indices16"], [0, 2, 1, 0, 3, 2])
        self.assertEqual(a["indices32"].dtype, np.dtype("<u4"))
        np.testing.assert_array_equal(a["mesh_part_start"], [0, 2])
        np.testing.assert_array_equal(a["part_range"], [[0, 3], [3, 3], [0, 6]])
        np.testing.assert_array_equal(a["mesh_bounds"][0], [0, 0, 0, 2, 2, 0])
        np.testing.assert_array_equal(a["normals"][0], [0, 0, 127])
        np.testing.assert_array_equal(a["inst_slot_start"], [0, 2])
        np.testing.assert_array_equal(a["slot_category"], [0, CATEGORIES.index("decal"), 0])
        np.testing.assert_array_equal(a["slot_color"][1], [0, 0, 0, 0])
        np.testing.assert_array_equal(a["slot_material"], [0, 1, 0])
        # column-major 3x4: translation is the last column
        np.testing.assert_array_equal(a["inst_matrix"][0], [1, 0, 0, 0, 1, 0, 0, 0, 1, 10, 0, -5])

    def test_slot_count_must_match_parts(self):
        self.ds.instances[0].slots.pop()
        with self.assertRaises(ValueError):
            dataset.write(self.ds, self.root / "bad")

    def test_build_is_deterministic(self):
        dataset.write(self.ds, self.root / "a")
        dataset.write(assemble(self.root / "cache"), self.root / "b")
        self.assertTrue(compare_datasets.compare(self.root / "a", self.root / "b", log=lambda *_: None))
        for name in ("index.json", "chunk-0.t3d", "sources.json"):
            self.assertEqual((self.root / "a" / name).read_bytes(), (self.root / "b" / name).read_bytes())

    def test_compare_reports_differences(self):
        dataset.write(self.ds, self.root / "a")
        self.ds.instances[0].matrix[0, 3] += 1.0
        dataset.write(self.ds, self.root / "b")
        lines = []
        self.assertFalse(compare_datasets.compare(self.root / "a", self.root / "b", log=lines.append))
        self.assertTrue(any("inst_matrix" in line for line in lines), lines)


@unittest.skipUnless(support.HAS_REAL_CACHE, "extraction cache not present (make cache-pull)")
class ValidationChecksTest(unittest.TestCase):
    """HANDOFF "Validation checks", over the real Customs cache (explore profile)."""

    @classmethod
    def setUpClass(cls):
        p = build.PROFILES["explore"]
        cls.ds = build.assemble(support.REAL_CACHE, "customs", "customs-explore", "explore", lod=p["lod"],
                                min_prop_size=p["min_prop_size"], decimate_ratio=p["decimate_ratio"],
                                decimate_min_tris=200, terrain_step=p["terrain_step"],
                                skip_names=p["skip_names"], include_indoor=False, log=lambda *_: None)
        cls.by_name = {}
        for inst in cls.ds.instances:
            cls.by_name.setdefault(cls.ds.geoms[inst.geom].name, []).append(inst)

    def size(self, inst):
        lo, hi = self.ds.geoms[inst.geom].bounds()
        wa = build.geometry.world_aabb(lo, hi, inst.matrix)
        return float((wa.max(axis=0) - wa.min(axis=0)).max())

    def scale(self, inst):
        return float(np.linalg.norm(inst.matrix[:3, :3], axis=0).max())

    def cats(self, name):
        return {s.category for inst in self.by_name[name] for s in inst.slots}

    def test_ferma_big_end(self):
        (inst,) = self.by_name["ferma_big_end"]
        self.assertAlmostEqual(self.size(inst), 29.0, delta=0.5)
        self.assertAlmostEqual(self.scale(inst), 0.06, delta=0.01)

    def test_pipe_filter_is_small(self):
        insts = self.by_name["Pipe_filter_06_A_LOD0"]
        self.assertEqual(len(insts), 4)
        for inst in insts:
            self.assertLess(self.size(inst), 0.2)
            self.assertAlmostEqual(self.scale(inst), 0.03, delta=0.01)

    def test_entrance_gate_and_shadow(self):
        gates = self.by_name["Enterance_Gate_01_L_LOD0"]
        shadows = self.by_name["Enterance_Gate_01_L_SHADOW_LOD0"]
        self.assertEqual(len(gates), len(shadows))
        for inst in gates + shadows:
            self.assertLess(self.size(inst), 6.0)
        gate_pos = sorted(tuple(np.round(i.matrix[:3, 3], 2)) for i in gates)
        shadow_pos = sorted(tuple(np.round(i.matrix[:3, 3], 2)) for i in shadows)
        self.assertEqual(gate_pos, shadow_pos)
        self.assertEqual(self.cats("Enterance_Gate_01_L_SHADOW_LOD0"), {"shadow"})

    def test_categories(self):
        self.assertEqual(self.cats("Treatment_Plant_outdoor_01_LOD0"), {"structure"})
        self.assertEqual(self.cats("pine01_LOD0"), {"foliage"})
        self.assertEqual(self.cats("Tree_pine01"), {"foliage"})
        self.assertEqual(self.cats("Water_storage_01_A_LOD0"), {"structure"})
        self.assertEqual(self.cats("water_cooler"), {"structure"})
        self.assertEqual(self.cats("Shoreline_Lake_Water_03_LOD0"), {"water"})

    def test_lod_meshes_are_not_skipped_by_name(self):
        self.assertTrue(any(n.endswith("_LOD1") or n.endswith("_LOD2") for n in self.by_name))

    def test_no_giant_phantom_objects(self):
        # invariant 2: wrong PPtr resolution produced props hundreds of metres big
        for inst in self.ds.instances:
            if self.ds.geoms[inst.geom].name.startswith("Pipe_filter"):
                self.assertLess(self.size(inst), 5.0)

    def test_terrain_slices_present(self):
        terrain = sorted(g.name for g in self.ds.geoms if g.kind == "terrain")
        self.assertEqual(terrain, ["Terrain_Slice_3_2", "Terrain_Slice_3_3"])

    def test_totals(self):
        st = dataset.stats(self.ds)
        self.assertEqual(st["instanceCount"], 141_088)
        self.assertEqual(st["instancedTriangles"], 91_989_746)


if __name__ == "__main__":
    unittest.main()
