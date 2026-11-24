# Offset tools

Two tools keep `game/eft/offsets/eft.offsets.json` in sync with a game build:

1. **`il2cpp-dump`** (`build/bin/il2cpp-dump`) reads the running game (or a memory dump) and writes
   **every** IL2CPP class with its parent and fields, plus the Unity globals and the modules' PE
   fingerprints, to a JSON file.
2. **`tools/update-offsets.py`** (Python 3, no dependencies) fills the offsets file from that dump,
   by class and field name.

Keeping them separate means one dump per game build is enough. Re-matching after editing the catalogue
needs no VM, and the dump doubles as a reference for exploring the game's classes (`jq`, `grep`).

Both take `--help`.

## Workflow

```sh
# 1. In a raid (some classes and fields are only set up once used), dump:
sudo ./build/bin/il2cpp-dump --device "qemu://hugepage-pid=$(pgrep -f 'guest=<vm>')" --out spt-dump.json
#    (or against a raw memory dump: --device spt-raid.raw)

# 2. Preview, then apply:
python3 tools/update-offsets.py spt-dump.json --dry-run
python3 tools/update-offsets.py spt-dump.json

# 3. Rebuild (the offsets are compiled in) and check the result with `radar-diagnose --device …` (in a raid).
cmake --build build
```

`update-offsets.py` prints what changed, what couldn't be resolved, and warnings. If a **required**
entry can't be resolved it writes nothing and exits 1. Look the class or field up in the dump, fix
the catalogue entry (class or field name) in `eft.offsets.json`, and run it again. `--force` writes
anyway.

**If the dumper can't find the type-info table**, its `notes` say what it tried; pass the table's RVA
with `--type-info-rva`. **The Unity globals only validate in a raid** (they need live objects behind
them); unvalidated ones are reported but not applied unless `--accept-unvalidated`.

## Finding layouts by hand

The dump only covers **managed** field offsets, type indices and the two Unity globals. The
`managedLayout` (IL2CPP runtime structs) and `unityLayout` (native engine structs) blocks are
maintained by hand, and an engine upgrade can move them without any warning from the updater.
Symptoms of that: `radar-diagnose` fails a step although its offsets "resolved", e.g. "GamePlayerOwner
has no static fields block" in a raid, players without positions, or unreadable cameras.

`mem-peek` (`build/bin/mem-peek`) reads commands from stdin and prints memory with hints (pointer, C
string it points to, managed class of the object it points to). See its header or `--help`.

```sh
D="qemu://hugepage-pid=$(pgrep -f 'guest=')"
printf 'q up+2054CB0 8\nq 249200dcd60 c0\n' | ./build/bin/mem-peek --device "$D"   # a global and what it points to
echo 'd 2537f6b4c70 60' | ./build/bin/mem-peek --device "$D"                      # floats: TRS, matrices
echo 'w up+0 2245000 up.bin' | ./build/bin/mem-peek --device "$D"                 # module image, for objdump
```

Work from objects you can already reach through managed code: `GamePlayerOwner._myPlayer` gives the
local player; its `UnityObject.CachedPtr` is the native component, which leads to the GameObject (name
string), its component array (entry 0 is the Transform) and the TransformHierarchy (parent-index array
starts with -1; the TRS array holds the player's position). For a global, disassemble the code that
uses it (`objdump -D -b binary -mi386:x86-64 -Mintel` on the image) to read struct offsets off the
instructions, then add a signature for it in `tools/il2cpp-dump/Dumper.cpp`.

What changed in the Unity 6 update (SPT, 2026-11): `Il2CppClass.StaticFields` 0xB8 → 0xA0; native
objects lost 0x10 of header (GameObject, Component, Camera fields mostly moved down by 0x10); a
component's managed object sits behind a GC handle slot (`Component.ManagedHandle` →
`ManagedHandle.Object`); the GameObjectManager keeps a sentinel list node {last, first} at 0x18; the
camera managers became plain objects behind the static `CameraManager._instance`.

## Dump format

```jsonc
{
  "dumpedBy": "radar il2cpp-dump",
  "schema": 1,
  "backend": "IL2CPP",
  "process": "EscapeFromTarkov.exe",      // the process that was dumped
  "modules": {
    "GameAssembly.dll": { "base": "0x7FF6…", "imageSize": "0x…", "peTimestamp": "0x…", "sizeOfImage": "0x…" },
    "UnityPlayer.dll":  { … }
  },
  "typeInfoTable": { "rva": "0x5FB0F48", "method": "signature:initStore", "validated": true, … },
  "unity": {
    "gameObjectManager": { "rva": "0x1A233A0", "validated": true, … },
    "allCameras": { "rva": "0x19F3080", "validated": false, "note": "not validated (…)" }
  },
  "staticFieldsOffset": "0xB8",           // Il2CppClass::StaticFields, as the dumper assumes it
  "typeCount": 5008,                      // entries in the type-info table
  "notes": [ "type-info table: signature initStore matched 1 time(s)", … ],
  "classes": [                            // sorted by typeIndex
    { "typeIndex": 8725, "name": "Player", "namespace": "EFT", "fullName": "EFT.Player",
      "declaringType": null, "parent": "UnityEngine.MonoBehaviour", "parentTypeIndex": 1234,
      "classPtr": "0x1F2A…",
      "fieldsInitialised": true,
      "fields": [
        { "name": "<Profile>k__BackingField", "type": "EFT.Profile", "offset": 2496, "offsetHex": "0x9C0",
          "isStatic": false, "isLiteral": false, "declaringClass": "EFT.Player" },
        { "name": "bossBoar", "type": "EFT.WildSpawnType", "offset": 0, "offsetHex": "0x0",
          "isStatic": true, "isLiteral": true, "declaringClass": "EFT.WildSpawnType" } ] } ]
}
```

| Key | Meaning |
|---|---|
| `fullName` | `Namespace.Name`, or just `Name` for nested types (their namespace is empty). |
| `fieldsInitialised` | `false` means IL2CPP hasn't set up this class's fields yet (it does so lazily, on first use). Dump again later, in a raid. |
| `fields` | The class's **own** fields only; inherited fields are found by following `parent`. |
| `offset` | Instance fields: from the object start, including the 16-byte object header. Static fields: into the class's static field block. `-1`: thread-static. Literals (`isLiteral`) have no storage. |
| `type` | Best effort; don't parse it strictly. |
| `classPtr` | Address of the class's `Il2CppClass` in the dumped process (session-specific). |
| `parentTypeIndex` | Set when the parent is in the table. Generic instances (e.g. ``List`1``) aren't; then only `parent` is set. |

**Literals** (`isLiteral`: consts and enum members) have no storage, and the dump has no values for
them; the entries in `eft.offsets.json`'s `literals[]` are maintained by hand. Older dumps that still
carry `metadata` and per-field `value` are fine: `update-offsets.py` ignores both.

Pointers are session-specific; everything else should be identical between two dumps of the same
build.

The reference dump lives at `dumps/il2cpp-dump.json` in the asset store (README, "Data files");
`tools/assets.py pull dumps/` fetches it.

If a dump comes out empty or garbled, the IL2CPP struct layouts the dumper assumes (`managedLayout`
in `eft.offsets.json`, fitting metadata v29-era runtimes) may not match. Check the game's
`global-metadata.dat` version (int32 at file offset 4).

## Matching rules

- **Classes** are looked up by full name; a name without a namespace also matches a short name.
  More than one match is an error ("ambiguous"), never a guess.
- **Fields** are searched in the class, then its base classes. Common name variants are tried
  (`<X>k__BackingField`, `_X`, `X`, …).
- **Literals** (`literals[]`) are never changed: they have no name in the metadata. Verify them by
  hand.
- The type-info table RVA, Unity globals and build fingerprints are taken from the dump too.
- Unresolved **non-required** entries keep their old value. The file keeps its layout, so diffs stay
  readable.
