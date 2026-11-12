"""Ground height map: what is ground, what stands on it."""

import unittest

import numpy as np

from . import support  # noqa: F401
from t3d import ground
from .test_hlod import box


def at(g: ground.GroundMap, values: np.ndarray, x: float, z: float):
    return values[int((z - g.origin[1]) / g.cell), int((x - g.origin[0]) / g.cell)]


def strip(x0, x1, y, half=5.0):
    """Horizontal rectangle facing up, from x0 to x1."""
    positions = np.array([[x0, y, -half], [x0, y, half], [x1, y, half], [x1, y, -half]], dtype=np.float32)
    return positions, np.array([0, 1, 2, 0, 2, 3], dtype=np.uint32)


def rect(x0, x1, z0, z1, y=0.0):
    positions = np.array([[x0, y, z0], [x0, y, z1], [x1, y, z1], [x1, y, z0]], dtype=np.float32)
    return positions, np.array([0, 1, 2, 0, 2, 3], dtype=np.uint32), False


def ring(outer: float, inner: float):
    """Flat ground from -outer to outer with a square hole of half-width `inner`: the baked map
    has no floor under a roof."""
    return [rect(-outer, outer, -outer, -inner), rect(-outer, outer, inner, outer),
            rect(-outer, -inner, -inner, inner), rect(inner, outer, -inner, inner)]


class GroundMapTest(unittest.TestCase):
    def test_street_with_a_building_and_a_car(self):
        surfaces = [*ring(40, 8),
                    (*box((-8, 0, -8), (8, 7, 8)), False),        # building
                    (*box((25, 0, 0), (27, 1.5, 4)), False)]      # car
        g = ground.height_map(surfaces, ((-40, -40), (40, 40)))
        self.assertLess(np.abs(g.heights).max(), 0.05)             # under the building as well
        self.assertTrue(at(g, g.building, 0, 0))
        self.assertTrue(at(g, g.building, 7.5, 7.5))               # up to its edge
        self.assertFalse(at(g, g.building, 26, 2))                 # too narrow
        self.assertFalse(at(g, g.building, -30, 30))

    def test_a_bridge_is_ground(self):
        # A valley of heightmap terrain between two banks, and a deck across it.
        valley = np.array([[-30, 0, -20], [-30, 0, 20], [0, -10, 20], [0, -10, -20], [30, 0, 20], [30, 0, -20]],
                          dtype=np.float32)
        terrain = (valley, np.array([0, 1, 2, 0, 2, 3, 3, 2, 4, 3, 4, 5], dtype=np.uint32), True)
        g = ground.height_map([terrain, (*strip(-30, 30, 0.0), False)], ((-30, -20), (30, 20)))
        self.assertAlmostEqual(float(at(g, g.heights, 0, 0)), 0.0, delta=0.05)     # on the deck
        self.assertLess(float(at(g, g.heights, 0, 15)), -8.0)                      # beside it
        self.assertFalse(g.building.any())

    def test_a_roof_is_not_ground(self):
        # A flat roof that nothing leads up to stays above the ground, however large it is.
        surfaces = [*ring(150, 60), (*box((-60, 0, -60), (60, 5, 60)), False)]
        g = ground.height_map(surfaces, ((-150, -150), (150, 150)))
        self.assertLess(abs(float(at(g, g.heights, 0, 0))), 0.05)


if __name__ == "__main__":
    unittest.main()
