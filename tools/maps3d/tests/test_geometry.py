import unittest

import numpy as np

from . import support
from t3d import geometry


def face_normal(positions, indices, tri=0):
    a, b, c = positions[indices[tri * 3: tri * 3 + 3]]
    n = np.cross(b - a, c - a)
    return n / np.linalg.norm(n)


class CoordinateTest(unittest.TestCase):
    def test_matrix_conversion_is_s_m_s(self):
        m = np.arange(16, dtype=np.float64).reshape(4, 4)
        out = geometry.to_three_matrix(m)
        np.testing.assert_array_equal(out, geometry.S @ m @ geometry.S)
        # translation z flips, x/y stay
        np.testing.assert_array_equal(geometry.to_three_matrix(support.translation(1, 2, 3))[:3, 3], [1, 2, -3])

    def test_point_conversion_commutes_with_matrices(self):
        """three(M) * three(p) == three(M * p): positions (x, y, -z), matrices S.M.S."""
        rng = np.random.default_rng(1)
        m = np.eye(4)
        m[:3, :] = rng.normal(size=(3, 4))
        p = np.append(rng.normal(size=3), 1.0)
        flip = np.array([1, 1, -1, 1])
        np.testing.assert_allclose(geometry.to_three_matrix(m) @ (p * flip), (m @ p) * flip)

    def test_mesh_flips_z_and_winding(self):
        mesh = support.quad_mesh(z=2.0)
        positions, normals, indices, parts = geometry.mesh_to_three(mesh)
        np.testing.assert_array_equal(positions[:, 2], [-2.0] * 4)
        np.testing.assert_array_equal(indices, [0, 2, 1, 0, 3, 2])
        # Unity: clockwise seen from -Z is front facing, i.e. the quad faces -Z.
        # In three.js space that is +Z and must be counter-clockwise (normal +Z).
        np.testing.assert_allclose(face_normal(positions, indices), [0, 0, 1])
        np.testing.assert_allclose(normals, [[0, 0, 1]] * 4, atol=1e-6)
        np.testing.assert_array_equal(parts, [[0, 6]])

    def test_world_aabb(self):
        m = geometry.to_three_matrix(support.translation(10, 0, 5))
        wa = geometry.world_aabb(np.zeros(3), np.ones(3), m)
        np.testing.assert_allclose(wa.min(axis=0), [10, 0, -5])
        np.testing.assert_allclose(wa.max(axis=0), [11, 1, -4])


class PartsTest(unittest.TestCase):
    def test_submeshes_become_parts(self):
        mesh = support.quad_mesh(submeshes=[[0, 3, 0], [3, 3, 0]])
        parts = geometry.mesh_to_three(mesh)[3]
        np.testing.assert_array_equal(parts, [[0, 3], [3, 3]])

    def test_empty_submeshes_are_dropped(self):
        mesh = support.quad_mesh(submeshes=[[0, 0, 0], [0, 6, 0]])
        np.testing.assert_array_equal(geometry.mesh_to_three(mesh)[3], [[0, 6]])

    def test_irregular_submeshes_collapse_to_one_part(self):
        for subs in ([[0, 3, 0], [3, 3, 1]],      # second is not a triangle list
                     [[3, 3, 0], [0, 3, 0]],      # out of order
                     [[0, 3, 0], [0, 3, 0]],      # overlapping, does not tile
                     [[0, 2, 0], [2, 4, 0]]):     # not on triangle boundaries
            mesh = support.quad_mesh(submeshes=subs)
            np.testing.assert_array_equal(geometry.mesh_to_three(mesh)[3], [[0, 6]], err_msg=str(subs))

    def test_out_of_range_indices_are_dropped(self):
        mesh = support.quad_mesh(submeshes=[[0, 3, 0], [3, 3, 0]])
        mesh.indices = np.array([0, 1, 2, 0, 2, 9], dtype=np.uint32)
        _, _, indices, parts = geometry.mesh_to_three(mesh)
        self.assertEqual(len(indices), 5)
        np.testing.assert_array_equal(parts, [[0, 5]])
        mesh.indices = np.array([9, 9, 9], dtype=np.uint32)
        self.assertIsNone(geometry.mesh_to_three(mesh))


class TerrainTest(unittest.TestCase):
    def test_height_scale_and_orientation(self):
        heights = np.zeros((3, 3), dtype=np.int16)
        heights[1, 2] = 16384   # row = z, column = x
        positions, normals, indices, parts = geometry.terrain_mesh(heights, [2.0, 180.0, 4.0], 1)
        self.assertEqual(len(positions), 9)
        self.assertEqual(len(indices), 4 * 6)
        np.testing.assert_array_equal(parts, [[0, 24]])
        peak = positions[1 * 3 + 2]
        # local_y = raw / 32768 * scale.y; z is authored negated (three.js space)
        np.testing.assert_allclose(peak, [4.0, 90.0, -4.0])
        # flat corner faces up, triangles are counter-clockwise seen from above
        np.testing.assert_allclose(normals[0], [0, 1, 0], atol=1e-6)
        flat = np.zeros((3, 3), dtype=np.int16)
        p, _, i, _ = geometry.terrain_mesh(flat, [1.0, 1.0, 1.0], 1)
        np.testing.assert_allclose(face_normal(p, i), [0, 1, 0])

    def test_step_and_degenerate(self):
        heights = np.zeros((5, 5), dtype=np.int16)
        self.assertEqual(len(geometry.terrain_mesh(heights, [1, 1, 1], 2)[0]), 9)
        self.assertIsNone(geometry.terrain_mesh(np.zeros((1, 1), dtype=np.int16), [1, 1, 1], 1))


class TerrainColorTest(unittest.TestCase):
    def test_blend_by_splat_weights(self):
        a = np.zeros((2, 2, 4), dtype=np.uint8)
        b = np.zeros((2, 2, 4), dtype=np.uint8)
        a[0, 0, 0] = 255                 # layer 0 only
        a[0, 1, 0] = a[0, 1, 1] = 100    # layers 0 and 1, equal weight
        b[1, 0, 1] = 40                  # layer 5 only (second map, channel 1)
        colors = [[200, 0, 0, 255], [0, 100, 0], None, None, None, [10, 20, 30]]
        out = geometry.terrain_colors([a, b], colors)
        self.assertEqual(out.shape, (2, 2, 3))
        # the splat maps are top row first, the result has row 0 at local z = 0: rows swap
        np.testing.assert_array_equal(out[1, 0], [200, 0, 0])
        np.testing.assert_array_equal(out[1, 1], [100, 50, 0])
        np.testing.assert_array_equal(out[0, 0], [10, 20, 30])
        # uncovered pixels take the weighted average ground: (255*red + 100*red + 100*green + 40*c5) / 495
        np.testing.assert_array_equal(out[0, 1], [144, 22, 2])

    def test_nothing_to_blend(self):
        empty = np.zeros((2, 2, 4), dtype=np.uint8)
        self.assertIsNone(geometry.terrain_colors([], []))
        self.assertIsNone(geometry.terrain_colors([empty], [[1, 2, 3]]))
        self.assertIsNone(geometry.terrain_colors([empty + 9], [None]))


class NormalsTest(unittest.TestCase):
    def test_compute_normals(self):
        p = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0]], dtype=np.float32)
        n = geometry.compute_normals(p, np.array([0, 1, 2], dtype=np.uint32))
        np.testing.assert_allclose(n, [[0, 0, 1]] * 3)


if __name__ == "__main__":
    unittest.main()
