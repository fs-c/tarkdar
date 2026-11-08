"""Tests for cmake/gen_offsets.py. Run via CTest (sets GEN_OFFSETS and OFFSETS_JSON)."""
import copy
import importlib.util
import json
import os
import unittest

spec = importlib.util.spec_from_file_location("gen_offsets", os.environ["GEN_OFFSETS"])
gen = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gen)

BASE = {
    "schema": 1,
    "build": {"GameAssembly.dll": None, "UnityPlayer.dll": {"peTimestamp": "0x10", "imageSize": 4096}},
    "bootstrap": {"typeInfoTableRva": "0x5FB0F48"},
    "unityRvas": {"gameObjectManager": "0x1A233A0"},
    "unityLayout": {"GameObject.Components": "0x58"},
    "managedLayout": {},
    "types": [{"group": "GamePlayerOwner", "name": "TypeIndex", "class": "EFT.GamePlayerOwner", "value": "0x2215"}],
    "fields": [{"group": "Player", "name": "Profile", "class": "EFT.Player", "field": "<Profile>k__BackingField",
                "static": False, "required": True, "value": "0x900"}],
    "literals": [{"group": "LootList", "name": "Items", "value": "0x10", "note": "List._items"}],
}


class GenOffsetsTest(unittest.TestCase):
    def doc(self, **overrides):
        d = copy.deepcopy(BASE)
        d.update(overrides)
        return d

    def test_generates_expected_declarations(self):
        text = gen.generate(self.doc())
        self.assertIn('{"GameAssembly.dll", false, 0, 0}', text)
        self.assertIn('{"UnityPlayer.dll", true, 0x10, 0x1000}', text)
        self.assertIn("inline constexpr std::uint64_t typeInfoTableRva = 0x5FB0F48;", text)
        self.assertIn("namespace GameObject {", text)
        self.assertIn("inline constexpr std::uint32_t Components = 0x58;", text)
        self.assertIn("inline constexpr std::int32_t TypeIndex = 0x2215;", text)
        self.assertIn("inline constexpr std::uint32_t Profile = 0x900;", text)
        self.assertIn("inline constexpr std::uint32_t Items = 0x10;", text)

    def test_optional_fields(self):
        d = self.doc()
        d["fields"].append({"group": "CompoundItem", "name": "Grids", "class": "X", "field": "Grids",
                            "optional": True, "value": None})
        d["fields"].append({"group": "CompoundItem", "name": "Known", "class": "X", "field": "K",
                            "optional": True, "value": "0x70"})
        text = gen.generate(d)
        self.assertIn("inline constexpr std::optional<std::uint32_t> Grids = std::nullopt;", text)
        self.assertIn("inline constexpr std::optional<std::uint32_t> Known = 0x70;", text)
        d["fields"][-1]["optional"] = False
        d["fields"][-1]["value"] = None
        with self.assertRaises(gen.SchemaError):
            gen.generate(d)

    def test_rejects_duplicates(self):
        d = self.doc()
        d["fields"].append(copy.deepcopy(d["fields"][0]))
        with self.assertRaisesRegex(gen.SchemaError, "duplicate"):
            gen.generate(d)

    def test_rejects_bad_values(self):
        for bad in ["0x", "12abc", "017", -1, True, None, "0x1FFFFFFFF"]:
            d = self.doc()
            d["fields"][0]["value"] = bad
            with self.assertRaises(gen.SchemaError, msg=repr(bad)):
                gen.generate(d)

    def test_rejects_bad_identifiers_and_reserved_groups(self):
        for group in ["Bad Name", "1abc", "build"]:
            d = self.doc()
            d["fields"][0]["group"] = group
            with self.assertRaises(gen.SchemaError, msg=group):
                gen.generate(d)

    def test_rejects_malformed_build_entry(self):
        with self.assertRaisesRegex(gen.SchemaError, "build"):
            gen.generate(self.doc(build={"GameAssembly.dll": "0x123"}))

    def test_rejects_wrong_schema(self):
        with self.assertRaisesRegex(gen.SchemaError, "schema"):
            gen.generate(self.doc(schema=2))

    def test_comment_injection_is_neutralised(self):
        d = self.doc()
        d["fields"][0]["class"] = "Evil */ int x; /*\nnext"
        text = gen.generate(d)
        self.assertNotIn("*/ int x", text)
        self.assertNotIn("\nnext", text)

    def test_checked_in_offsets_file_is_valid(self):
        with open(os.environ["OFFSETS_JSON"], encoding="utf-8") as f:
            gen.generate(json.load(f))


if __name__ == "__main__":
    unittest.main()
