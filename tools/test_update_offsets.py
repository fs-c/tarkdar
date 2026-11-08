"""Tests for tools/update-offsets.py. Run via CTest (sets UPDATE_OFFSETS and OFFSETS_JSON)."""
import contextlib
import copy
import importlib.util
import io
import json
import os
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("update_offsets", os.environ["UPDATE_OFFSETS"])
uo = importlib.util.module_from_spec(spec)
spec.loader.exec_module(uo)


def field(name, offset, static=False, literal=False):
    return {"name": name, "type": "?", "offset": offset, "isStatic": static, "isLiteral": literal}


DUMP = {
    "schema": 1,
    "modules": {"GameAssembly.dll": {"base": "0x7FF600000000", "imageSize": "0x6000000",
                                     "peTimestamp": "0x65AABBCC", "sizeOfImage": "0x6000000"}},
    "typeInfoTable": {"rva": "0x5ABC000", "pointer": "0x1000", "method": "signature:initStore", "validated": True},
    "unity": {"gameObjectManager": {"rva": "0x1B00000", "validated": True, "families": ["gomInitStore"],
                                    "layout": {"lastActiveNode": "0x20", "activeNodes": "0x28"}},
              "allCameras": {"rva": "0x1A00000", "validated": False, "families": ["camCount"], "note": "no raid"}},
    "classes": [
        {"typeIndex": 10, "name": "MonoBehaviour", "namespace": "UnityEngine", "fullName": "UnityEngine.MonoBehaviour",
         "parent": None, "parentTypeIndex": None, "fieldsInitialised": True, "fields": [field("m_CachedPtr", 0x10)]},
        {"typeIndex": 11, "name": "Player", "namespace": "EFT", "fullName": "EFT.Player", "parent": "UnityEngine.MonoBehaviour",
         "parentTypeIndex": 10, "fieldsInitialised": True,
         "fields": [field("<Profile>k__BackingField", 0xA00), field("_corpse", 0x700), field("MaxHp", 0, literal=True),
                    field("ThreadLocal", -1, static=True)]},
        {"typeIndex": 12, "name": "LocalPlayer", "namespace": "EFT", "fullName": "EFT.LocalPlayer", "parent": "EFT.Player",
         "parentTypeIndex": 11, "fieldsInitialised": True, "fields": [field("_corpse", 0x900)]},
        {"typeIndex": 13, "name": "GamePlayerOwner", "namespace": "EFT", "fullName": "EFT.GamePlayerOwner",
         "parent": None, "fieldsInitialised": True, "fields": [field("_myPlayer", 0x8, static=True)]},
        {"typeIndex": 20, "name": "Info", "namespace": "", "fullName": "Info", "fieldsInitialised": True, "fields": []},
        {"typeIndex": 21, "name": "Info", "namespace": "", "fullName": "Info", "fieldsInitialised": True, "fields": []},
        {"typeIndex": 22, "name": "Lazy", "namespace": "EFT", "fullName": "EFT.Lazy", "fieldsInitialised": False, "fields": []},
    ],
}

OFFSETS = {
    "schema": 1,
    "note": "test",
    "build": {"GameAssembly.dll": None, "UnityPlayer.dll": None},
    "bootstrap": {"typeInfoTableRva": "0x1"},
    "unityRvas": {"gameObjectManager": "0x2", "allCameras": "0x3"},
    "unityLayout": {"GameObjectManager.LastActiveNode": "0x28", "GameObjectManager.ActiveNodes": "0x30"},
    "managedLayout": {},
    "types": [{"group": "GamePlayerOwner", "name": "TypeIndex", "class": "EFT.GamePlayerOwner", "required": True, "value": "0x99"}],
    "fields": [
        {"group": "GamePlayerOwner", "name": "MyPlayer", "class": "EFT.GamePlayerOwner", "field": "_myPlayer",
         "static": True, "required": True, "value": "0x8"},
        {"group": "Player", "name": "Profile", "class": "EFT.Player", "field": "<Profile>k__BackingField",
         "static": False, "required": True, "value": "0x9C0"},
        {"group": "Local", "name": "Corpse", "class": "EFT.LocalPlayer", "field": "_corpse", "static": False,
         "required": False, "value": "0x1"},
        {"group": "Local", "name": "CachedPtr", "class": "EFT.LocalPlayer", "field": "m_CachedPtr", "static": False,
         "required": False, "value": "0x1"},
    ],
    "literals": [{"group": "PlayerBody", "name": "SkeletonRootJoint", "value": "0x40", "note": "guessed"}],
}


class UpdateOffsetsTest(unittest.TestCase):
    def run_update(self, offsets=None, dump=None, **kw):
        doc = copy.deepcopy(offsets or OFFSETS)
        report = uo.update(doc, uo.Dump(copy.deepcopy(dump or DUMP)), **kw)
        return doc, report

    def test_types_fields_and_inheritance(self):
        doc, report = self.run_update()
        self.assertEqual(doc["types"][0]["value"], "0xD")
        f = {e["name"]: e["value"] for e in doc["fields"]}
        self.assertEqual(f["MyPlayer"], "0x8")
        self.assertEqual(f["Profile"], "0xA00")
        self.assertEqual(f["Corpse"], "0x900")      # derived class shadows the base field
        self.assertEqual(f["CachedPtr"], "0x10")    # inherited from MonoBehaviour, two levels up
        self.assertEqual(report.missing, [])
        self.assertIn("GamePlayerOwner::MyPlayer (EFT.GamePlayerOwner :: _myPlayer)", report.unchanged)
        self.assertEqual(len(report.manual), 1)

    def test_name_candidates(self):
        self.assertEqual(uo.field_candidates("<Side>k__BackingField"),
                         ["<Side>k__BackingField", "_Side_k__BackingField", "_Side", "Side"])
        self.assertEqual(uo.field_candidates("_rotation"), ["_rotation", "rotation", "<rotation>k__BackingField"])
        dump = copy.deepcopy(DUMP)
        dump["classes"][1]["fields"][0]["name"] = "_Profile"  # renamed backing field
        doc, report = self.run_update(dump=dump)
        self.assertEqual(next(e for e in doc["fields"] if e["name"] == "Profile")["value"], "0xA00")
        self.assertTrue(any("matched as _Profile" in w for w in report.warnings))

    def test_literals_and_thread_statics_are_ignored(self):
        offsets = copy.deepcopy(OFFSETS)
        offsets["fields"].append({"group": "P", "name": "Max", "class": "EFT.Player", "field": "MaxHp",
                                  "static": True, "required": False, "value": "0x0"})
        offsets["fields"].append({"group": "P", "name": "TL", "class": "EFT.Player", "field": "ThreadLocal",
                                  "static": True, "required": False, "value": "0x0"})
        _, report = self.run_update(offsets=offsets)
        self.assertEqual(len([u for u in report.unresolved if "P::" in u]), 2)

    def test_missing_required_and_ambiguity(self):
        offsets = copy.deepcopy(OFFSETS)
        offsets["types"].append({"group": "Info", "name": "TypeIndex", "class": "Info", "required": True, "value": "0x0"})
        offsets["fields"].append({"group": "Lazy", "name": "X", "class": "EFT.Lazy", "field": "x",
                                  "static": False, "required": True, "value": "0x10"})
        doc, report = self.run_update(offsets=offsets)
        self.assertEqual(len(report.missing), 2)
        self.assertTrue(any("ambiguous" in m for m in report.missing))
        self.assertTrue(any("not set up yet" in m for m in report.missing))
        self.assertEqual(doc["fields"][-1]["value"], "0x10")  # kept

    def test_static_mismatch_is_a_warning(self):
        offsets = copy.deepcopy(OFFSETS)
        offsets["fields"][0]["static"] = False
        _, report = self.run_update(offsets=offsets)
        self.assertTrue(any("static" in w for w in report.warnings))

    def test_bootstrap_unity_and_build(self):
        doc, report = self.run_update()
        self.assertEqual(doc["bootstrap"]["typeInfoTableRva"], "0x5ABC000")
        self.assertEqual(doc["unityRvas"]["gameObjectManager"], "0x1B00000")
        self.assertEqual(doc["unityRvas"]["allCameras"], "0x3")  # not validated: kept
        self.assertEqual(doc["unityLayout"]["GameObjectManager.LastActiveNode"], "0x20")
        self.assertEqual(doc["build"]["GameAssembly.dll"], {"peTimestamp": "0x65AABBCC", "imageSize": "0x6000000"})
        self.assertIsNone(doc["build"]["UnityPlayer.dll"])
        doc, _ = self.run_update(accept_unvalidated=True)
        self.assertEqual(doc["unityRvas"]["allCameras"], "0x1A00000")
        doc, _ = self.run_update(unity=False, build=False)
        self.assertEqual(doc["unityRvas"]["gameObjectManager"], "0x2")
        self.assertIsNone(doc["build"]["GameAssembly.dll"])

    def test_meatydumper_layout(self):
        dump = {"namespaces": [{"name": "EFT", "classes": [
            {"typeIndex": 13, "name": "GamePlayerOwner", "fullName": "EFT.GamePlayerOwner",
             "fields": [{"name": "_myPlayer", "offset": 8, "isStatic": True}]}]}]}
        doc, report = self.run_update(dump=dump)
        self.assertEqual(doc["types"][0]["value"], "0xD")

    def test_main_writes_preserving_format_and_refuses_on_missing(self):
        with tempfile.TemporaryDirectory() as d:
            dump_path, offsets_path = os.path.join(d, "dump.json"), os.path.join(d, "offsets.json")
            with open(dump_path, "w") as f:
                json.dump(DUMP, f)
            with open(offsets_path, "w") as f:
                json.dump(OFFSETS, f, indent=2)
                f.write("\n")
            original = open(offsets_path).read()
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(uo.main([dump_path, "--offsets", offsets_path, "--dry-run"]), 0)
            self.assertEqual(open(offsets_path).read(), original)
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(uo.main([dump_path, "--offsets", offsets_path]), 0)
            text = open(offsets_path).read()
            self.assertTrue(text.endswith("}\n"))
            self.assertEqual(list(json.loads(text).keys()), list(OFFSETS.keys()))  # key order kept
            self.assertIn('"value": "0xA00"', text)

            # A dump without the required class: nothing written, exit 1 (unless --force).
            with open(dump_path, "w") as f:
                json.dump({"classes": []}, f)
            before = open(offsets_path).read()
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(uo.main([dump_path, "--offsets", offsets_path]), 1)
            self.assertEqual(open(offsets_path).read(), before)
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(uo.main([dump_path, "--offsets", offsets_path, "--force"]), 1)

    def test_checked_in_offsets_file_runs(self):
        with open(os.environ["OFFSETS_JSON"]) as f:
            doc = json.load(f)
        report = uo.update(doc, uo.Dump({"classes": []}))
        self.assertGreater(len(report.missing), 0)
        self.assertEqual(report.changed, [])


if __name__ == "__main__":
    unittest.main()
