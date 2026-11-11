"""Cell merge, simplification and the visibility bake."""

import unittest

import numpy as np

from . import support  # noqa: F401
from t3d import dataset, hlod, visibility


def box(lo, hi, inward=False):
    """Axis-aligned box as 12 triangles, faces pointing outward (counter-clockwise
    seen from outside) or inward."""
    lo, hi = np.asarray(lo, dtype=np.float32), np.asarray(hi, dtype=np.float32)
    corners = np.array([[x, y, z] for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])],
                       dtype=np.float32)
    quads = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]   # -x +x -y +y -z +z
    tris = []
    for a, b, c, d in quads:
        tris += [(a, b, c), (a, c, d)]
    indices = np.array(tris, dtype=np.uint32)
    if inward:
        indices = indices[:, [0, 2, 1]]
    return corners, indices.reshape(-1)


def plane(y, half=20.0):
    """Horizontal square facing up."""
    positions = np.array([[-half, y, -half], [-half, y, half], [half, y, half], [half, y, -half]], dtype=np.float32)
    return positions, np.array([0, 1, 2, 0, 2, 3], dtype=np.uint32)


def join(*meshes):
    positions, indices, offset = [], [], 0
    for p, i in meshes:
        positions.append(p)
        indices.append(i + offset)
        offset += len(p)
    return np.concatenate(positions), np.concatenate(indices)


DIRECTIONS = visibility.view_directions()


class BoxHelperTest(unittest.TestCase):
    def test_faces_point_outward(self):
        p, i = box([0, 0, 0], [1, 2, 3])
        normals = visibility.face_normals(p, i)
        centers = p[i.reshape(-1, 3)].mean(axis=1) - np.array([0.5, 1.0, 1.5])
        self.assertTrue((np.einsum("ij,ij->i", normals, centers) > 0).all())


class SamplingTest(unittest.TestCase):
    def test_directions(self):
        np.testing.assert_allclose(np.linalg.norm(DIRECTIONS, axis=1), 1.0)
        self.assertEqual(len(DIRECTIONS), 45)
        np.testing.assert_allclose(DIRECTIONS[0], [0, 1, 0], atol=1e-12)   # straight down onto the map
        self.assertTrue((DIRECTIONS[:, 1] < 0).any())                       # some look up from below

    def test_samples_cover_the_triangle(self):
        p = np.array([[0, 0, 0], [4, 0, 0], [0, 0, 1]], dtype=np.float32)
        points, owner = visibility.sample_triangles(p, np.array([0, 1, 2], dtype=np.uint32), 0.25)
        self.assertTrue((owner == 0).all())
        # rows along the longest edge (the hypotenuse, 4.12 m -> 17 steps), 4 steps across the height
        self.assertEqual(len(points), 18 * 5)
        # all inside the triangle
        self.assertTrue((points[:, 0] >= 0).all() and (points[:, 2] >= 0).all())
        self.assertTrue((points[:, 0] / 4 + points[:, 2] <= 1 + 1e-5).all())
        np.testing.assert_allclose(points[:, 1], 0, atol=1e-6)
        # no gap wider than the spacing along a row
        row = points[::5]
        self.assertLess(np.linalg.norm(np.diff(row, axis=0), axis=1).max(), 0.25)

    def test_thin_triangles_get_one_row(self):
        p = np.array([[0, 0, 0], [100, 0, 0], [50, 0, 0.01]], dtype=np.float32)
        points, _ = visibility.sample_triangles(p, np.array([0, 1, 2], dtype=np.uint32), 0.2)
        self.assertEqual(len(points), 501 * 2)

    def test_degenerate_triangle(self):
        p = np.zeros((3, 3), dtype=np.float32)
        points, owner = visibility.sample_triangles(p, np.array([0, 1, 2], dtype=np.uint32), 0.2)
        self.assertTrue(np.isfinite(points).all())
        self.assertEqual(len(points), len(owner))


class VisibilityTest(unittest.TestCase):
    def visible(self, mesh, **kw):
        return visibility.visible_triangles(*mesh, DIRECTIONS, **kw)

    def test_box_inside_a_closed_box_is_hidden(self):
        mesh = join(box([0, 0, 0], [10, 6, 10]), box([4, 2, 4], [6, 4, 6]))
        seen = self.visible(mesh)
        self.assertTrue(seen[:12].all())          # the shell, including its underside (seen from below)
        self.assertFalse(seen[12:].any())

    def test_open_top_shows_the_inside(self):
        shell_p, shell_i = box([0, 0, 0], [10, 6, 10])
        open_top = shell_i.reshape(-1, 3)[[t for t in range(12) if t not in (6, 7)]].reshape(-1)   # drop +y
        seen = self.visible(join((shell_p, open_top), box([4, 2, 4], [6, 4, 6])))
        self.assertTrue(seen[10:12].any())        # top of the inner box, through the opening
        self.assertFalse(seen[14:16].any())       # its underside stays hidden

    def test_back_faces_do_not_occlude(self):
        # A shell whose faces point inward is invisible from outside (culled),
        # so it must not hide what is inside it.
        mesh = join(box([0, 0, 0], [10, 6, 10], inward=True), box([4, 2, 4], [6, 4, 6]))
        self.assertTrue(self.visible(mesh)[12:].all())

    def test_bias_keeps_a_surface_just_behind_another(self):
        near = (np.array([[0, 5.0, 0], [0, 5.0, 4], [4, 5.0, 4]], dtype=np.float32), np.array([0, 1, 2], dtype=np.uint32))
        for gap, expected in ((0.1, True), (1.0, False)):
            behind = (near[0] - np.array([0, gap, 0], dtype=np.float32), near[1])
            up_only = DIRECTIONS[:1]
            seen = visibility.visible_triangles(*join(near, behind), up_only, bias=0.2)
            self.assertEqual(seen.tolist(), [True, expected], gap)

    def test_ground_hides_what_is_buried(self):
        ground = plane(0.0, 60.0)     # wide enough that no 10 degree ray passes under its edge
        buried = box([-1, -5, -1], [1, -2, 1])
        self.assertFalse(self.visible(buried, occluders=ground).any())
        self.assertTrue(self.visible(buried).all())           # without ground: seen from all sides

    def test_box_on_the_ground(self):
        seen = self.visible(box([-1, -1, -1], [1, 3, 1]), occluders=plane(0.0))
        sides = [0, 1, 2, 3, 8, 9, 10, 11]
        self.assertTrue(seen[sides].all())
        self.assertTrue(seen[6:8].all())          # top
        self.assertFalse(seen[4:6].any())         # underside is below the ground

    def test_underside_above_the_ground_is_seen_from_below(self):
        # a canopy: a slab floating 4 m above the ground
        seen = self.visible(box([-3, 4, -3], [3, 4.3, 3]), occluders=plane(0.0))
        self.assertTrue(seen[4:6].all())

    def test_empty(self):
        self.assertEqual(len(self.visible((np.zeros((0, 3), dtype=np.float32), np.zeros(0, dtype=np.uint32)))), 0)


class SimplifyTest(unittest.TestCase):
    def grid(self, n=20, size=10.0):
        """Flat n x n grid of quads in the XZ plane."""
        xs = np.linspace(0, size, n + 1, dtype=np.float32)
        x, z = np.meshgrid(xs, xs)
        positions = np.stack([x, np.zeros_like(x), z], axis=-1).reshape(-1, 3)
        r, c = np.meshgrid(np.arange(n), np.arange(n), indexing="ij")
        v = (r * (n + 1) + c).reshape(-1)
        indices = np.stack([v, v + n + 1, v + 1, v + 1, v + n + 1, v + n + 2], axis=-1).reshape(-1).astype(np.uint32)
        return positions, indices

    def test_flat_surface_collapses_and_stays_in_place(self):
        positions, indices = self.grid()
        out = hlod.simplify(positions, indices, 0.05)
        self.assertLess(len(out), len(indices) / 20)
        self.assertGreaterEqual(len(out), 6)
        used = positions[out]
        np.testing.assert_allclose(used.min(axis=0), [0, 0, 0])      # the outline is kept
        np.testing.assert_allclose(used.max(axis=0), [10, 0, 10])

    def test_error_bound_limits_the_change(self):
        positions, indices = self.grid()
        positions[:, 1] = 0.5 * np.sin(positions[:, 0])              # a wave, 1 m peak to peak
        fine = hlod.simplify(positions, indices, 0.01)
        coarse = hlod.simplify(positions, indices, 2.0)
        self.assertGreater(len(fine), len(coarse))
        self.assertGreater(np.ptp(positions[fine][:, 1]), 0.9)       # the wave survives a 1 cm bound

    def test_small_detached_parts_are_pruned(self):
        big = self.grid(4, 20.0)
        pebble = box([30, 0, 30], [30.02, 0.02, 30.02])
        positions, indices = join(big, pebble)
        out = hlod.simplify(positions, indices, 0.1)
        self.assertLess(positions[out][:, 0].max(), 21)              # the 2 cm box is gone
        self.assertEqual(len(hlod.simplify(positions, indices, 0.0)), len(indices))   # 0 = off

    def test_weld_and_degenerates(self):
        positions = np.array([[0, 0, 0], [1, 0, 0], [0, 0, 1], [0, 0, 0], [1, 0, 0], [1, 0, 1]], dtype=np.float32)
        colors = np.array([[9, 9, 9, 255]] * 5 + [[1, 2, 3, 255]], dtype=np.uint8)
        indices = np.array([0, 1, 2, 3, 4, 5, 0, 3, 1], dtype=np.uint32)
        idx, pos, col = hlod.weld(indices, positions, colors)
        self.assertEqual(len(pos), 4)                                 # two pairs merged
        np.testing.assert_array_equal(pos[idx], positions[indices])   # same triangles
        np.testing.assert_array_equal(col[idx], colors[indices])
        self.assertEqual(len(hlod.drop_degenerate(idx)), 6)           # the third uses a vertex twice now


class BakeTest(unittest.TestCase):
    """bake() on a hand-made Dataset: a house and a far shed (structure), a
    shadow proxy, a tree, and a terrain patch."""

    def dataset(self):
        def geom(name, mesh, kind="mesh", parts=None):
            p, i = mesh
            return dataset.Geom(name, kind, p, np.tile(np.float32([0, 1, 0]), (len(p), 1)), i,
                                np.array(parts or [[0, len(i)]], dtype=np.uint32))

        def at(x, y, z, scale=1.0):
            m = np.eye(4)
            m[:3, :3] *= scale
            m[:3, 3] = [x, y, z]
            return m

        house = geom("house", box([0, 0, 0], [8, 5, 8]), parts=[[0, 30], [30, 6]])   # walls + a glass face
        geoms = [house, geom("shadow_proxy", box([0, 0, 0], [8, 5, 8])), geom("pine01", box([0, 0, 0], [1, 6, 1])),
                 geom("Terrain_a", plane(0.0, 60.0), kind="terrain")]
        red = dataset.Slot("structure", color=(200, 10, 10, 255))
        instances = [
            dataset.Instance(0, at(10, 0, 10), 0, [red, dataset.Slot("glass")], 0),
            dataset.Instance(0, at(300, 0, 10, scale=0.5), 1, [dataset.Slot("structure"), dataset.Slot("glass")], 1),
            dataset.Instance(1, at(10, 0, 10), 0, [dataset.Slot("shadow")], 2),
            dataset.Instance(2, at(30, 0, 30), 0, [dataset.Slot("foliage")], 3),
            dataset.Instance(3, at(14, 0, 14), 2, [dataset.Slot("terrain")], 4),
        ]
        return dataset.Dataset("t", "T", "TAG", "overview", [{"level": f"l{i}", "path": f"s{i}"} for i in range(3)],
                               geoms, instances, [], ["a", "b", "c", "d", "e"], 5)

    def bake(self, **options):
        return hlod.bake(self.dataset(), hlod.Options(workers=2, **options), log=lambda *_: None)

    def test_cells_categories_and_passthrough(self):
        out = self.bake(hsr=False)
        names = [g.name for g in out.geoms]
        self.assertEqual(names, ["cell_0_0_glass", "cell_0_0_structure", "cell_2_0_glass", "cell_2_0_structure",
                                 "Terrain_a"])
        self.assertEqual([[s.category for s in i.slots] for i in out.instances],
                         [["glass"], ["structure"], ["glass"], ["structure"], ["terrain"]])
        self.assertEqual([s["level"] for s in out.scenes], ["cell 0,0", "cell 2,0", "l2"])
        self.assertEqual([i.scene for i in out.instances], [0, 0, 1, 1, 2])
        cells = out.geoms[:4]
        self.assertTrue(all(g.flat and g.colors is not None for g in cells))
        self.assertFalse(out.geoms[4].flat)
        for inst in out.instances[:4]:
            np.testing.assert_array_equal(inst.matrix, np.eye(4))
        # world space: the house was placed at (10, 0, 10), the shed scaled by 0.5 at (300, 0, 10)
        np.testing.assert_allclose(cells[1].positions.min(axis=0), [10, 0, 10])
        np.testing.assert_allclose(cells[1].positions.max(axis=0), [18, 5, 18])
        np.testing.assert_allclose(cells[3].positions.max(axis=0), [304, 2.5, 14])
        # colours: the slot colour, or the category colour
        self.assertEqual(set(map(tuple, cells[1].colors)), {(200, 10, 10, 255)})
        self.assertEqual(set(map(tuple, cells[3].colors)), {(*hlod.CATEGORY_COLOR["structure"], 255)})
        self.assertEqual(set(map(tuple, out.geoms[4].colors)), {(*hlod.CATEGORY_COLOR["terrain"], 255)})
        # 5 box faces of structure + 1 of glass per house; identity-matrix instances -> one slot each
        self.assertEqual([len(g.indices) // 3 for g in cells], [2, 10, 2, 10])
        self.assertEqual(out.paths, ["a", "b", "c", "d", "e"])
        self.assertEqual(out.instances[4].path, 4)

    def test_hidden_surfaces_are_removed(self):
        out = self.bake()
        structure = next(g for g in out.geoms if g.name == "cell_0_0_structure")
        # the underside sits on the terrain: 4 walls left (the +z face is the glass part)
        self.assertEqual(len(structure.indices) // 3, 8)
        self.assertGreater(structure.positions[structure.indices][:, 1].max(), 4.9)

    def test_mirrored_instances_keep_facing_outward(self):
        ds = self.dataset()
        ds.instances[0].matrix[0, 0] = -1.0          # mirror in x
        out = hlod.bake(ds, hlod.Options(workers=1, hsr=False), log=lambda *_: None)
        g = next(g for g in out.geoms if g.name.endswith("_structure"))
        normals = visibility.face_normals(g.positions, g.indices)
        center = (g.positions.min(axis=0) + g.positions.max(axis=0)) / 2
        outward = g.positions[g.indices.reshape(-1, 3)].mean(axis=1) - center
        self.assertTrue((np.einsum("ij,ij->i", normals, outward) > 0).all())

    def test_written_dataset_has_colours_and_flags(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            index = dataset.write(self.bake(hsr=False), tmp)
            _, chunks, _ = dataset.read(tmp)
            _, a = chunks[0]
            self.assertEqual(a["colors"].shape, (len(a["positions"]), 4))
            np.testing.assert_array_equal(a["mesh_flags"], [1, 1, 1, 1, 0])
            self.assertEqual(index["stats"]["categories"]["structure"]["triangles"], 20)


if __name__ == "__main__":
    unittest.main()
