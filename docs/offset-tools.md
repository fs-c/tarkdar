# Offset tools

Two tools keep `game/eft/offsets/eft.offsets.json` in sync with a game build:

1. **`il2cpp-dump`** (C++, `build/bin/il2cpp-dump`) reads the running game (or a memory dump) and
   writes **every** IL2CPP class with its parent and fields, plus the Unity globals, to a JSON file.
2. **`tools/update-offsets.py`** (Python 3, no dependencies) fills the offsets file from that dump,
   by class and field name.

Keeping them separate means one dump per game build is enough. Re-matching after editing the catalogue
needs no VM, and the dump doubles as a reference for exploring the game's classes (`jq`, `grep`).

## Workflow at the setup

```sh
# 1. In a raid (some classes and fields are only set up once used), dump:
sudo ./build/bin/il2cpp-dump --device "qemu://hugepage-pid=$(pgrep -f 'guest=<vm>')" --out spt-dump.json
#    (or against a raw memory dump: --device spt-raid.raw)

# 2. Preview, then apply:
python3 tools/update-offsets.py spt-dump.json --dry-run
python3 tools/update-offsets.py spt-dump.json

# 3. Rebuild (the offsets are compiled in) and check the result with radar-backend.
cmake --build build
```

`update-offsets.py` prints what changed, what couldn't be resolved, and warnings. If a **required**
entry can't be resolved it writes nothing and exits 1. Look the class or field up in the dump, fix
the catalogue entry (class or field name) in `eft.offsets.json`, and run it again. `--force` writes
anyway.

## `il2cpp-dump`

```
il2cpp-dump --device <leechcore-device> [--out il2cpp-dump.json] [--namespace <prefix>] [--class <text>]
            [--type-info-rva <hex>] [--no-broad] [--no-unity] [--timeout <sec>] [--vmm-arg <arg>] [--vmm-printf]
```

It attaches to `EscapeFromTarkov.exe` (names from `game/eft/Names.hpp`), then:

1. **Finds the type-info table** (the GameAssembly global pointing to `Il2CppClass*[]`, indexed by type
   definition index):
   - With `--type-info-rva`: uses that RVA (validated and reported, but used either way).
   - Otherwise:
     1. scans GameAssembly's executable sections for five known instruction patterns that load or
        store the global, and validates each candidate (retried for about 5 s while the game starts);
     2. if none validates, tries every RIP-relative `mov` (`--no-broad` skips this; it's slower);
     3. finally tries the compiled-in `bootstrap.typeInfoTableRva`.
   - A table validates when at least 8 of slots 0–15 and 3 of slots 5000–5007 hold classes with
     printable names.
2. **Counts types:** it scans the table until two consecutive 2048-slot chunks hold no new classes.
   Null slots are normal (classes are registered lazily); repeated class pointers are ignored.
3. **Reads every class:**
   - name, namespace, full name (`Namespace.Name`, or just `Name` for nested types, whose namespace is
     empty);
   - declaring (outer) type and parent class;
   - own fields with offset, static/const flags, declaring class and a best-effort type name.
4. **Finds the Unity globals:** `gameObjectManager` and `allCameras`, by instruction patterns in
   UnityPlayer. A candidate is **validated** only if live objects sit behind it, which needs a loaded
   scene (a raid). Unvalidated candidates are still reported, with a note.
5. **Records each module's PE fingerprint** (timestamp, image size), for the offsets file's `build`
   section.

The output is written atomically (to `<out>.tmp`, then renamed). The exit code is 1 if no type-info
table was found.

Filters (`--namespace` = prefix match, `--class` = substring of the full name) only affect what's
written. Type names are always resolved against all classes.

### Dump format (schema 1)

```jsonc
{
  "dumpedBy": "radar il2cpp-dump",
  "schema": 1,
  "backend": "IL2CPP",
  "process": "EscapeFromTarkov.exe",
  "modules": {
    "GameAssembly.dll": { "base": "0x7FF6…", "imageSize": "0x…", "peTimestamp": "0x…", "sizeOfImage": "0x…" },
    "UnityPlayer.dll":  { … }
  },
  "typeInfoTable": { "rva": "0x5FB0F48", "pointer": "0x…", "method": "signature:initStore", "validated": true },
  "staticFieldsOffset": "0xB8",          // Il2CppClass.static_fields offset the tool assumed
  "typeCount": 41234,
  "unity": {
    "gameObjectManager": { "rva": "0x1A233A0", "validated": true, "families": ["gomInitStore", …],
                           "layout": { "lastActiveNode": "0x20", "activeNodes": "0x28" } },
    "allCameras": { "rva": "0x19F3080", "validated": false, "families": [ … ], "note": "not validated (…)" }
  },
  "notes": [ "type-info table: signature initStore matched 1 time(s)", … ],
  "classes": [                            // sorted by typeIndex
    { "typeIndex": 8725, "name": "Player", "namespace": "EFT", "fullName": "EFT.Player",
      "declaringType": null, "parent": "UnityEngine.MonoBehaviour", "parentTypeIndex": 1234,
      "classPtr": "0x…", "fieldsInitialised": true,
      "fields": [
        { "name": "<Profile>k__BackingField", "type": "EFT.Profile", "offset": 2496, "offsetHex": "0x9C0",
          "isStatic": false, "isLiteral": false, "declaringClass": "EFT.Player" } ] } ]
}
```

| Key | Meaning |
|---|---|
| `method` | How the table was found: `override`, `signature:<name>`, `broad` or `compiled`. |
| `fieldsInitialised` | `false` means IL2CPP hasn't set up this class's fields yet (it does so lazily, on first use). Dump again later, in a raid. |
| `fields` | The class's **own** fields only; inherited fields are found by following `parent`. |
| `offset` | Instance fields: from the object start, including the 16-byte object header. Static fields: into the class's static field block. `-1`: thread-static. Literals (`isLiteral`) have no storage. |
| `type` | Best effort: a class's full name, a primitive (`int32_t`, `float`, `string`, …), `X[]`/`X*`/`X&`, or a kind name (`genericinst`, `class`, `valuetype`) when unresolved. Don't parse it strictly. |
| `parentTypeIndex` | Set when the parent is in the table. Generic instances (e.g. ``List`1``) aren't; then only `parent` is set. |

Pointers (`classPtr`, `pointer`, `base`) are session-specific; everything else should be identical
between two dumps of the same build.

### Layout assumptions
The IL2CPP struct offsets the tool uses (`Il2CppClass`, `FieldInfo`, `Il2CppType`) are in the
`managedLayout` section of `eft.offsets.json`. They fit IL2CPP metadata v29-era runtimes. If a dump
comes out empty or garbled, check the game's `global-metadata.dat` version (int32 at file offset 4) and
adjust them.

## `update-offsets.py`

```
update-offsets.py DUMP [--offsets FILE] [--dry-run] [--force] [--accept-unvalidated] [--no-unity] [--no-build]
```

Matching rules:
- **Classes:** the catalogue's `class` is looked up by full name. A name without a namespace also
  matches a class's short name (nested types have no namespace). More than one match is an error
  ("ambiguous"), never a guess.
- **Types** (`types[]`): `value` = the class's type index.
- **Fields** (`fields[]`):
  - The class's own fields are searched, then its base classes (up to 32 levels); a derived class's
    field shadows a base field with the same name.
  - Name variants are tried in order: `<X>k__BackingField` → itself, `_X_k__BackingField`, `_X`, `X`;
    and `_x` → itself, `x`, `<x>k__BackingField`.
  - Thread-static (`-1`) and literal fields are ignored.
  - A static flag that differs from the catalogue's is reported as a warning.
- **`bootstrap.typeInfoTableRva`:** from the dump if the table was validated.
- **`unityRvas.*`, `unityLayout.GameObjectManager.*`:** from validated Unity globals only (or with
  `--accept-unvalidated`).
- **`build.<module>`:** PE timestamp and image size from the dump's `modules`. With these recorded,
  `radar-backend` warns when the game build changes.
- **Literals** (`literals[]`): never changed. They're listed as "manual", because they have no name in
  the metadata. Verify them by hand.

Unresolved **non-required** entries keep their old value. The file is rewritten with the same layout
(key order, 2-space indent), so diffs stay readable.

The tool also reads MeatyDumper-style dumps (classes grouped under `namespaces`), though without
`parent` information, so inherited fields won't resolve from those.
