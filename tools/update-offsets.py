#!/usr/bin/env python3
"""Fill game/eft/offsets/eft.offsets.json from an il2cpp-dump JSON dump.

Usage: update-offsets.py DUMP [--offsets FILE] [--dry-run] [--force] [--accept-unvalidated]
                              [--no-unity] [--no-build]

Updates, by name:
  types[].value      type index of the class (by full name, or short name if the catalogue has no namespace)
  fields[].value     field offset, searching the class and then its base classes, trying name variants
                     (<X>k__BackingField / _X / X)
  bootstrap.typeInfoTableRva            if the dump's table location was validated
  unityRvas.gameObjectManager/allCameras, unityLayout.GameObjectManager.*   if validated (or --accept-unvalidated)
  build.<module>     PE timestamp and image size of the dumped game modules
Literals are never touched (reported as "manual").

If a required entry can't be resolved, nothing is written (unless --force) and the exit code is 1.
Also reads MeatyDumper-style dumps (classes grouped under "namespaces").
"""
import argparse
import json
import os
import re
import sys
from collections import defaultdict

DEFAULT_OFFSETS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "game", "eft", "offsets",
                               "eft.offsets.json")
MAX_DEPTH = 32
MAX_OFFSET = 0x4000


def hexs(v):
    return f"0x{v:X}"


def parse_int(v):
    if isinstance(v, int):
        return v
    if isinstance(v, str):
        return int(v, 16) if v.lower().startswith("0x") else int(v)
    raise ValueError(f"not an integer: {v!r}")


class Dump:
    def __init__(self, doc):
        self.doc = doc
        classes = doc.get("classes")
        if classes is None:  # MeatyDumper layout: {"namespaces": [{"name": ns, "classes": [...]}]}
            classes = []
            for ns in doc.get("namespaces", []):
                for c in ns.get("classes", []):
                    c = dict(c)
                    c.setdefault("namespace", ns.get("name", ""))
                    classes.append(c)
        self.classes = classes
        self.by_full = defaultdict(list)
        self.by_short = defaultdict(list)
        self.by_index = {}
        for c in classes:
            self.by_full[c["fullName"]].append(c)
            self.by_short[c["name"]].append(c)
            if "typeIndex" in c:
                self.by_index[c["typeIndex"]] = c

    def find_class(self, name):
        """Returns (class, error)."""
        found = self.by_full.get(name) or ([] if "." in name else self.by_short.get(name, []))
        if not found:
            return None, f"class {name} not in dump"
        if len(found) > 1:
            idx = ", ".join(str(c.get("typeIndex", "?")) for c in found)
            return None, f"class {name} is ambiguous (type indices {idx})"
        return found[0], None

    def parent_of(self, c):
        if c.get("parentTypeIndex") is not None and c["parentTypeIndex"] in self.by_index:
            return self.by_index[c["parentTypeIndex"]]
        parent = c.get("parent")
        if parent and len(self.by_full.get(parent, [])) == 1:
            return self.by_full[parent][0]
        return None


def field_candidates(name):
    m = re.fullmatch(r"<(.+)>k__BackingField", name)
    if m:
        prop = m.group(1)
        return [name, f"_{prop}_k__BackingField", f"_{prop}", prop]
    if name.startswith("_") and len(name) > 1:
        bare = name[1:]
        return [name, bare, f"<{bare}>k__BackingField"]
    return [name]


def find_field(dump, cls, field_name):
    """Returns (field, owner class, error). Derived-class fields shadow base-class fields."""
    merged = {}
    uninitialised = []
    c, depth, seen = cls, 0, set()
    while c is not None and depth < MAX_DEPTH and id(c) not in seen:
        seen.add(id(c))
        if c.get("fieldsInitialised") is False:
            uninitialised.append(c["fullName"])
        for f in c.get("fields", []):
            off = f.get("offset", -1)
            if f.get("isLiteral") or not (0 <= off < MAX_OFFSET):
                continue
            merged.setdefault(f["name"], (f, c))
        c = dump.parent_of(c)
        depth += 1
    for candidate in field_candidates(field_name):
        if candidate in merged:
            f, owner = merged[candidate]
            return f, owner, None
    hint = f" (fields not set up yet in {', '.join(uninitialised)}; dump again later in a raid)" if uninitialised else ""
    return None, None, f"field {field_name} not found in {cls['fullName']} or its base classes{hint}"


class Report:
    def __init__(self):
        self.changed, self.unchanged, self.unresolved, self.missing, self.warnings, self.manual = [], [], [], [], [], []

    def set(self, label, entry, key, new):
        old = entry.get(key)
        new_s = hexs(new)
        if old is not None and parse_int(old) == new:
            self.unchanged.append(label)
        else:
            self.changed.append(f"{label}: {old} -> {new_s}")
        entry[key] = new_s

    def print(self, out=None):
        out = out or sys.stdout
        def section(title, items):
            print(f"{title} ({len(items)})", file=out)
            for i in items:
                print(f"  {i}", file=out)
        section("changed", self.changed)
        print(f"unchanged ({len(self.unchanged)})", file=out)
        section("unresolved, kept old value", self.unresolved)
        section("REQUIRED but unresolved", self.missing)
        section("warnings", self.warnings)
        section("manual (literals; verify by hand)", self.manual)


def update(doc, dump, accept_unvalidated=False, unity=True, build=True):
    report = Report()

    for e in doc.get("types", []):
        label = f"{e['group']}::{e['name']} (type index of {e['class']})"
        c, err = dump.find_class(e["class"])
        if c is None or "typeIndex" not in c:
            (report.missing if e.get("required") else report.unresolved).append(f"{label}: {err or 'no type index'}")
            continue
        report.set(label, e, "value", c["typeIndex"])

    for e in doc.get("fields", []):
        label = f"{e['group']}::{e['name']} ({e['class']} :: {e['field']})"
        c, err = dump.find_class(e["class"])
        f = None
        if c is not None:
            f, _owner, err = find_field(dump, c, e["field"])
        if f is None:
            (report.missing if e.get("required") else report.unresolved).append(f"{label}: {err}")
            continue
        if "isStatic" in f and bool(f["isStatic"]) != bool(e.get("static")):
            report.warnings.append(f"{label}: catalogue says static={bool(e.get('static'))}, dump says {f['isStatic']}")
        if f["name"] != e["field"]:
            report.warnings.append(f"{label}: matched as {f['name']}")
        report.set(label, e, "value", f["offset"])

    for e in doc.get("literals", []):
        report.manual.append(f"{e['group']}::{e['name']} = {e['value']}" + (f" ({e['note']})" if e.get("note") else ""))

    table = dump.doc.get("typeInfoTable")
    if table and table.get("rva") is not None and "typeInfoTableRva" in doc.get("bootstrap", {}):
        if table.get("validated") or accept_unvalidated:
            report.set("bootstrap.typeInfoTableRva", doc["bootstrap"], "typeInfoTableRva", parse_int(table["rva"]))
        else:
            report.unresolved.append("bootstrap.typeInfoTableRva: dump's table location not validated")

    if unity:
        for name, g in (dump.doc.get("unity") or {}).items():
            if name not in doc.get("unityRvas", {}):
                continue
            if g.get("rva") is None:
                report.unresolved.append(f"unityRvas.{name}: {g.get('note', 'not found')}")
                continue
            if not g.get("validated") and not accept_unvalidated:
                report.unresolved.append(f"unityRvas.{name}: candidate {g['rva']} not validated ({g.get('note', '')})")
                continue
            report.set(f"unityRvas.{name}", doc["unityRvas"], name, parse_int(g["rva"]))
            layout = g.get("layout")
            if name == "gameObjectManager" and layout and g.get("validated"):
                ul = doc.setdefault("unityLayout", {})
                for key, field in (("GameObjectManager.LastActiveNode", "lastActiveNode"),
                                   ("GameObjectManager.ActiveNodes", "activeNodes")):
                    if key in ul:
                        report.set(f"unityLayout.{key}", ul, key, parse_int(layout[field]))

    if build:
        modules = dump.doc.get("modules") or {}
        for name in list(doc.get("build", {}).keys()):
            m = modules.get(name)
            if not m or m.get("peTimestamp") is None or m.get("sizeOfImage") is None:
                report.unresolved.append(f"build.{name}: no fingerprint in dump")
                continue
            new = {"peTimestamp": hexs(parse_int(m["peTimestamp"])), "imageSize": hexs(parse_int(m["sizeOfImage"]))}
            old = doc["build"][name]
            if old == new:
                report.unchanged.append(f"build.{name}")
            else:
                report.changed.append(f"build.{name}: {old} -> {new}")
                doc["build"][name] = new
    return report


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("dump")
    ap.add_argument("--offsets", default=DEFAULT_OFFSETS)
    ap.add_argument("--dry-run", action="store_true", help="report only, don't write")
    ap.add_argument("--force", action="store_true", help="write even if required entries are unresolved")
    ap.add_argument("--accept-unvalidated", action="store_true",
                    help="use table/Unity locations the dumper couldn't validate against live objects")
    ap.add_argument("--no-unity", action="store_true", help="don't touch unityRvas/unityLayout")
    ap.add_argument("--no-build", action="store_true", help="don't touch the build fingerprints")
    args = ap.parse_args(argv)

    with open(args.dump, encoding="utf-8") as f:
        dump = Dump(json.load(f))
    with open(args.offsets, encoding="utf-8") as f:
        doc = json.load(f)

    report = update(doc, dump, args.accept_unvalidated, unity=not args.no_unity, build=not args.no_build)
    report.print()

    failed = bool(report.missing)
    if args.dry_run:
        print("dry run: nothing written")
    elif failed and not args.force:
        print(f"not writing {args.offsets}: required entries unresolved (use --force to write anyway)")
    else:
        tmp = args.offsets + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(doc, f, indent=2)
            f.write("\n")
        os.replace(tmp, args.offsets)
        print(f"wrote {args.offsets}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
