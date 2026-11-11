import tempfile
import unittest
from pathlib import Path

import numpy as np

from . import support  # noqa: F401
from t3d import cache, pack


class PackTest(unittest.TestCase):
    def arrays(self):
        return {
            "b": np.arange(7, dtype=np.uint8),
            "a": np.linspace(0, 1, 12, dtype="<f4").reshape(4, 3),
            "empty": np.zeros((0, 2), dtype="<u4"),
        }

    def test_round_trip(self):
        meta = {"k": [1, 2, {"x": "é"}]}
        out_meta, out = pack.decode(pack.encode(meta, self.arrays()))
        self.assertEqual(out_meta, meta)
        for name, a in self.arrays().items():
            self.assertEqual(out[name].dtype, a.dtype)
            self.assertEqual(out[name].shape, a.shape)
            np.testing.assert_array_equal(out[name], a)

    def test_deterministic_and_order_independent(self):
        a = self.arrays()
        self.assertEqual(pack.encode({"x": 1, "y": 2}, a),
                         pack.encode({"y": 2, "x": 1}, dict(reversed(list(a.items())))))

    def test_arrays_are_16_byte_aligned(self):
        raw = pack.encode({}, self.arrays())
        _, arrays = pack.decode(raw)
        base = np.frombuffer(raw, dtype=np.uint8).__array_interface__["data"][0]
        for a in arrays.values():
            if a.size:
                self.assertEqual((a.__array_interface__["data"][0] - base) % 16, 0)

    def test_rejects_other_data(self):
        with self.assertRaises(ValueError):
            pack.decode(b"NOPE" + bytes(32))

    def test_file_round_trip(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "sub" / "x.pack.zst"
            pack.write(path, {"hello": "world"}, self.arrays())
            meta, arrays = pack.read(path)
            self.assertEqual(meta, {"hello": "world"})
            np.testing.assert_array_equal(arrays["a"], self.arrays()["a"])
            self.assertEqual(pack.read_meta(path), {"hello": "world"})


class CacheTest(unittest.TestCase):
    def test_scene_key(self):
        self.assertEqual(cache.scene_key("Assets/Content/Locations/City/x.unity"), "Content/Locations/City/x")

    def test_mesh_store_round_trip(self):
        positions = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0]], dtype=np.float32)
        indices = np.array([0, 1, 2], dtype=np.uint32)
        normals = np.array([[0, 0, 127, 0]] * 3, dtype=np.int8)
        attrs = {4: (0, np.array([[0, 0], [1, 0], [0, 1]], dtype="<f4")),
                 3: (2, np.array([[255, 0, 0, 255]] * 3, dtype=np.uint8))}
        subs = [[0, 3, 0]]
        h = cache.mesh_hash(positions, indices, subs, normals, 3, attrs)
        with tempfile.TemporaryDirectory() as tmp:
            store = cache.MeshStore(Path(tmp))
            store.add(cache.Mesh(h, positions, indices, subs, normals, 3, attrs))
            self.assertEqual(store.flush(), 1)
            (mesh,) = list(cache.MeshStore(Path(tmp)).iter_meshes({h}))
            self.assertEqual(mesh.hash, h)
            self.assertEqual(mesh.submeshes, subs)
            np.testing.assert_array_equal(mesh.positions, positions)
            np.testing.assert_array_equal(mesh.indices, indices)
            np.testing.assert_allclose(mesh.normals(), [[0, 0, 1]] * 3)
            np.testing.assert_array_equal(mesh.attribute("uv0"), attrs[4][1])
            np.testing.assert_allclose(mesh.attribute("color"), [[1, 0, 0, 1]] * 3)
            self.assertIsNone(mesh.attribute("uv1"))
            with self.assertRaises(KeyError):
                list(cache.MeshStore(Path(tmp)).iter_meshes({"ff" + "0" * 30}))

    def test_mesh_hash_depends_on_submeshes(self):
        p = np.zeros((3, 3), dtype=np.float32)
        i = np.array([0, 1, 2], dtype=np.uint32)
        self.assertNotEqual(cache.mesh_hash(p, i, [[0, 3, 0]], None, None),
                            cache.mesh_hash(p, i, [[0, 3, 1]], None, None))


if __name__ == "__main__":
    unittest.main()
