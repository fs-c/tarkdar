"""UnityPy scene walker. The only module that needs the game files.

Records *everything* a later build might want, without filtering: disabled /
inactive renderers, every LOD level, colliders, terrain heightmaps + trees,
material names, hierarchy paths. Filtering is the build stage's job.
"""

from __future__ import annotations

import math
import time
from collections import Counter
from pathlib import Path

import re

import numpy as np
import UnityPy

from .cache import KEPT_CHANNELS, VERTEX_FORMATS, Mesh, MeshStore, TextureStore, mesh_hash

# Unity VertexAttributeFormat -> bytes per component.
COMPONENT_SIZE = {0: 4, 1: 2, 2: 1, 3: 1, 4: 2, 5: 2, 6: 1, 7: 1, 8: 2, 9: 2, 10: 4, 11: 4}

COLLIDER_KIND = {"BoxCollider": 0, "SphereCollider": 1, "CapsuleCollider": 2, "MeshCollider": 3}

# Material texture slots that get a downsampled RGBA thumbnail in the texture
# store (colour sources). Other slots (normal/spec/cube maps) only record
# name + dimensions.
ALBEDO_SLOT_RE = re.compile(r"^_(MainTex|BaseMap|BaseColorMap|Albedo|AlbedoMap|Diffuse|DiffuseMap|Color|ColorMap|TintMask)\d*$", re.I)
THUMB_MAX = 128          # material albedo / terrain layer thumbnails
SPLAT_MAX = 1024         # terrain splat (alpha) maps, stored per scene


def build_settings_scenes(game_dir: Path) -> list[str]:
    env = UnityPy.load(str(Path(game_dir) / "globalgamemanagers"))
    for obj in env.objects:
        if obj.type.name == "BuildSettings":
            return list(obj.read().scenes)
    return []


def unity_version(game_dir: Path) -> str:
    env = UnityPy.load(str(Path(game_dir) / "globalgamemanagers"))
    for f in env.files.values():
        v = getattr(f, "unity_version", None)
        if v:
            return str(v)
    return "unknown"


# ---------------------------------------------------------------------------
# Math
# ---------------------------------------------------------------------------

def quat_to_mat3(q) -> np.ndarray:
    x, y, z, w = float(q.x), float(q.y), float(q.z), float(q.w)
    n = math.sqrt(x * x + y * y + z * z + w * w)
    if n == 0:
        return np.eye(3)
    x, y, z, w = x / n, y / n, z / n, w / n
    return np.array(
        [
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
        ],
        dtype=np.float64,
    )


def local_matrix(t) -> np.ndarray:
    m = np.eye(4, dtype=np.float64)
    s = t.m_LocalScale
    m[:3, :3] = quat_to_mat3(t.m_LocalRotation) * np.array([s.x, s.y, s.z])
    p = t.m_LocalPosition
    m[:3, 3] = [p.x, p.y, p.z]
    return m


# ---------------------------------------------------------------------------
# Mesh decoding (raw, Unity space)
# ---------------------------------------------------------------------------

class MeshDecodeError(Exception):
    pass


def _stream_layout(channels, vcount):
    stream_count = 1 + max((c.stream for c in channels if c.dimension > 0), default=0)
    layout = {}
    offset = 0
    for s in range(stream_count):
        stride = sum(
            (c.dimension & 0xF) * COMPONENT_SIZE.get(c.format, 4)
            for c in channels
            if c.stream == s and c.dimension > 0
        )
        layout[s] = (offset, stride)
        offset += stride * vcount
        offset = (offset + 15) & ~15
    return layout


def _channel(blob, layout, vcount, ch, dtype, components):
    base, stride = layout[ch.stream]
    raw = np.frombuffer(blob, dtype=np.uint8, count=vcount * stride, offset=base).reshape(vcount, stride)
    arr = raw[:, ch.offset : ch.offset + components * dtype.itemsize]
    return np.ascontiguousarray(arr).view(dtype).reshape(vcount, components)


def _indices(mesh):
    raw = np.asarray(mesh.m_IndexBuffer, dtype=np.uint8)
    use32 = int(getattr(mesh, "m_IndexFormat", 0) or 0) == 1
    if not use32 and len(raw) % 2 == 0:
        max_first = max((sm.firstByte for sm in mesh.m_SubMeshes), default=0)
        use32 = max_first > 0 and max_first % 2 != 0
    dtype = np.dtype("<u4") if use32 else np.dtype("<u2")
    values = raw.view(dtype)
    bpe = dtype.itemsize
    pieces, submeshes = [], []
    first = 0
    for sm in mesh.m_SubMeshes:
        start = sm.firstByte // bpe
        count = int(sm.indexCount)
        idx = values[start : start + count].astype(np.uint32)
        base = int(getattr(sm, "baseVertex", 0) or 0)
        if base:
            idx = idx + base
        pieces.append(idx)
        submeshes.append([first, len(idx), int(getattr(sm, "topology", 0) or 0)])
        first += len(idx)
    indices = np.concatenate(pieces) if pieces else np.empty(0, dtype=np.uint32)
    return indices, submeshes


def decode_mesh(mesh, data_dir: Path) -> Mesh:
    vd = mesh.m_VertexData
    vcount = int(vd.m_VertexCount)
    if vcount == 0:
        raise MeshDecodeError("empty vertex data")
    blob = bytes(vd.m_DataSize) if vd.m_DataSize else b""
    sd = mesh.m_StreamData
    if sd is not None and int(sd.size) > 0:
        res = Path(str(sd.path).replace("\\", "/")).name
        with open(Path(data_dir) / res, "rb") as f:
            f.seek(int(sd.offset))
            blob = f.read(int(sd.size))
    if not blob:
        raise MeshDecodeError("no vertex blob")

    channels = list(vd.m_Channels)
    layout = _stream_layout(channels, vcount)
    pos_ch = channels[0]
    if pos_ch.dimension == 0 or pos_ch.format != 0:
        raise MeshDecodeError(f"unsupported position channel format={pos_ch.format}")
    positions = _channel(blob, layout, vcount, pos_ch, np.dtype("<f4"), 3).copy()

    normals_raw, normal_format = None, None
    if len(channels) > 1 and channels[1].dimension > 0:
        nch = channels[1]
        dt = {0: np.dtype("<f4"), 1: np.dtype("<f2"), 2: np.dtype(np.uint8), 3: np.dtype(np.int8)}.get(nch.format)
        if dt is not None:
            normals_raw = _channel(blob, layout, vcount, nch, dt, nch.dimension & 0xF).copy()
            normal_format = int(nch.format)

    attributes = {}
    for ch in KEPT_CHANNELS:
        if ch >= len(channels):
            break
        c = channels[ch]
        dim = c.dimension & 0xF
        dt = VERTEX_FORMATS.get(int(c.format))
        if dim == 0 or dt is None:
            continue
        attributes[ch] = (int(c.format), _channel(blob, layout, vcount, c, dt, dim).copy())

    indices, submeshes = _indices(mesh)
    h = mesh_hash(positions, indices, submeshes, normals_raw, normal_format, attributes)
    return Mesh(h, positions, indices, submeshes, normals_raw, normal_format, attributes)


def _vec(v, n=4) -> list:
    return [float(getattr(v, a)) for a in "xyzw"[:n]] if not hasattr(v, "r") else \
        [float(v.r), float(v.g), float(v.b), float(v.a)]


def _thumbnail(tex, max_dim: int) -> np.ndarray:
    """Decode a Texture2D and box-downsample to <= max_dim. RGBA8, top row first."""
    from PIL import Image  # UnityPy dependency

    img = tex.image.convert("RGBA")
    w, h = img.size
    scale = max(w, h) / max_dim
    if scale > 1:
        img = img.resize((max(1, round(w / scale)), max(1, round(h / scale))), Image.Resampling.BOX)
    return np.asarray(img, dtype=np.uint8)


# ---------------------------------------------------------------------------
# Scene extraction
# ---------------------------------------------------------------------------

class _Zero:
    x = y = z = w = 0.0


_Zero4 = _Zero()


class StringTable:
    def __init__(self):
        self.values: list[str] = []
        self._index: dict[str, int] = {}

    def __call__(self, s: str | None) -> int:
        s = s or ""
        i = self._index.get(s)
        if i is None:
            i = self._index[s] = len(self.values)
            self.values.append(s)
        return i


class Extractor:
    """Extracts scenes into a MeshStore + per-scene (meta, arrays)."""

    def __init__(self, game_dir: Path, store: MeshStore, textures: TextureStore):
        self.game_dir = Path(game_dir)
        self.store = store
        self.textures = textures
        # (target file, path_id) -> {"hash", "name", "status"}; shared across scenes
        self.mesh_refs: dict[tuple, dict] = {}
        self.material_names: dict[tuple, str] = {}
        self.material_infos: dict[tuple, dict] = {}
        self.texture_infos: dict[tuple, dict] = {}

    @staticmethod
    def _target(pptr) -> tuple:
        """Resolve a PPtr to (file name, path_id). Path IDs are per file."""
        fid = int(pptr.file_id)
        f = pptr.assetsfile
        if fid == 0:
            name = f.name
        else:
            name = f.externals[fid - 1].path
        return (Path(str(name).replace("\\", "/")).name.lower(), int(pptr.path_id))

    def mesh_ref(self, pptr) -> dict | None:
        if pptr is None or int(pptr.path_id) == 0:
            return None
        key = self._target(pptr)
        ref = self.mesh_refs.get(key)
        if ref is not None:
            return ref
        name = ""
        try:
            mesh = pptr.read()
            name = mesh.m_Name or ""
            m = decode_mesh(mesh, self.game_dir)
            self.store.add(m)
            ref = {"hash": m.hash, "name": name, "status": "ok"}
        except MeshDecodeError as exc:
            ref = {"hash": None, "name": name, "status": str(exc)}
        except Exception as exc:  # noqa: BLE001 - recorded, not fatal
            ref = {"hash": None, "name": name, "status": f"error: {type(exc).__name__}: {exc}"}
        self.mesh_refs[key] = ref
        return ref

    def material_name(self, pptr) -> str:
        if pptr is None or int(pptr.path_id) == 0:
            return ""
        try:
            key = self._target(pptr)
        except Exception:  # noqa: BLE001
            return ""
        name = self.material_names.get(key)
        if name is None:
            try:
                name = pptr.read().m_Name or ""
            except Exception:  # noqa: BLE001
                name = ""
            self.material_names[key] = name
        return name

    def texture_info(self, pptr, thumb: bool, max_dim: int = THUMB_MAX) -> dict | None:
        """{"name","width","height","format","thumb": hash|None,"mean": rgba|None,"status"}."""
        if pptr is None or int(pptr.path_id) == 0:
            return None
        try:
            # Keyed by the thumb flag too: an entry must not depend on which
            # scenes happened to request the texture earlier in the run, or
            # scene files would not be deterministic.
            key = (*self._target(pptr), thumb)
        except Exception:  # noqa: BLE001
            return None
        info = self.texture_infos.get(key)
        if info is not None:
            return info
        info = {"name": "", "width": 0, "height": 0, "format": -1, "thumb": None, "mean": None, "status": "ok"}
        try:
            t = pptr.read()
            info.update(name=t.m_Name or "", width=int(getattr(t, "m_Width", 0) or 0),
                        height=int(getattr(t, "m_Height", 0) or 0),
                        format=int(getattr(t, "m_TextureFormat", -1) or -1), type=pptr.type.name)
            if thumb:
                if pptr.type.name != "Texture2D":
                    info["status"] = f"not a Texture2D ({pptr.type.name})"
                else:
                    rgba = _thumbnail(t, max_dim)
                    info["thumb"] = self.textures.add(rgba)
                    info["mean"] = [round(float(x), 2) for x in rgba.reshape(-1, 4).mean(axis=0)]
        except Exception as exc:  # noqa: BLE001 - recorded, not fatal
            info["status"] = f"error: {type(exc).__name__}: {exc}"[:200]
        self.texture_infos[key] = info
        return info

    def material_info(self, pptr) -> dict | None:
        """Shader, render queue, keywords, colour/float props, texture slots."""
        if pptr is None or int(pptr.path_id) == 0:
            return None
        try:
            key = self._target(pptr)
        except Exception:  # noqa: BLE001
            return None
        info = self.material_infos.get(key)
        if info is not None:
            return info
        info = {"name": "", "shader": "", "renderQueue": -1, "keywords": [], "colors": {}, "floats": {},
                "textures": {}, "status": "ok"}
        try:
            m = pptr.read()
            info["name"] = m.m_Name or ""
            try:
                info["shader"] = m.m_Shader.read().m_ParsedForm.m_Name
            except Exception:  # noqa: BLE001
                info["shader"] = "?"
            info["renderQueue"] = int(getattr(m, "m_CustomRenderQueue", -1))
            kw = getattr(m, "m_ValidKeywords", None) or getattr(m, "m_ShaderKeywords", "") or []
            info["keywords"] = sorted(kw.split() if isinstance(kw, str) else list(kw))
            sp = m.m_SavedProperties
            info["colors"] = {n: _vec(c) for n, c in sp.m_Colors}
            info["floats"] = {n: float(v) for n, v in sp.m_Floats}
            for slot, te in sp.m_TexEnvs:
                ti = self.texture_info(te.m_Texture, thumb=bool(ALBEDO_SLOT_RE.match(slot)))
                if ti is not None:
                    info["textures"][slot] = {"texture": ti, "scale": _vec(te.m_Scale, 2),
                                              "offset": _vec(te.m_Offset, 2)}
        except Exception as exc:  # noqa: BLE001
            info["status"] = f"error: {type(exc).__name__}: {exc}"[:200]
        self.material_infos[key] = info
        return info

    def extract_scene(self, level: str, scene_path: str):
        t0 = time.time()
        env = UnityPy.load(str(self.game_dir / level))
        objects = list(env.objects)
        by_type: dict[str, list] = {}
        for o in objects:
            by_type.setdefault(o.type.name, []).append(o)

        transforms = {o.path_id: o.read() for o in by_type.get("Transform", []) + by_type.get("RectTransform", [])}
        strings = StringTable()
        stats = Counter()

        go_info: dict[int, tuple] = {}  # transform pid -> (name, active_self, layer)

        def go_of(pid):
            info = go_info.get(pid)
            if info is None:
                go = transforms[pid].m_GameObject.read()
                info = go_info[pid] = (go.m_Name or "", bool(go.m_IsActive), int(go.m_Layer))
            return info

        active_cache: dict[int, bool] = {}

        def is_active(pid):
            v = active_cache.get(pid)
            if v is None:
                v = go_of(pid)[1]
                f = transforms[pid].m_Father
                if v and f is not None and f.path_id != 0:
                    v = is_active(f.path_id)
                active_cache[pid] = v
            return v

        world_cache: dict[int, np.ndarray] = {}

        def world(pid):
            m = world_cache.get(pid)
            if m is None:
                t = transforms[pid]
                m = local_matrix(t)
                f = t.m_Father
                if f is not None and f.path_id != 0:
                    m = world(f.path_id) @ m
                world_cache[pid] = m
            return m

        path_cache: dict[int, str] = {}

        def hier_path(pid):
            p = path_cache.get(pid)
            if p is None:
                name = go_of(pid)[0]
                f = transforms[pid].m_Father
                p = f"{hier_path(f.path_id)}/{name}" if f is not None and f.path_id != 0 else name
                path_cache[pid] = p
            return p

        # Scene-local mesh reference table (indexes into it from renderers/colliders).
        ref_index: dict[int, int] = {}
        refs: list[dict] = []

        def ref_id(pptr) -> int:
            ref = self.mesh_ref(pptr)
            if ref is None:
                return -1
            i = ref_index.get(id(ref))
            if i is None:
                i = ref_index[id(ref)] = len(refs)
                refs.append(ref)
            return i

        # Scene-local material / texture tables. Materials reference textures
        # by index into meta["textures"]; renderers by index into meta["materials"].
        mat_index: dict[int, int] = {}
        materials: list[dict] = []
        tex_index: dict[int, int] = {}
        textures: list[dict] = []

        def tex_id(info) -> int:
            if info is None:
                return -1
            i = tex_index.get(id(info))
            if i is None:
                i = tex_index[id(info)] = len(textures)
                textures.append(info)
            return i

        def mat_id(pptr) -> int:
            info = self.material_info(pptr)
            if info is None:
                return -1
            i = mat_index.get(id(info))
            if i is None:
                i = mat_index[id(info)] = len(materials)
                entry = {k: v for k, v in info.items() if k != "textures"}
                entry["textures"] = {slot: {"texture": tex_id(t["texture"]), "scale": t["scale"], "offset": t["offset"]}
                                     for slot, t in info["textures"].items()}
                materials.append(entry)
            return i

        # --- LOD groups -------------------------------------------------------
        # Raw memberships in serialization order. A renderer can appear in
        # several LODs and even several groups; the build decides semantics.
        memberships: list[tuple[int, int, int]] = []  # (renderer path id, group, level)
        groups = []
        for gi, o in enumerate(by_type.get("LODGroup", [])):
            lg = o.read()
            heights = []
            for li, lod in enumerate(lg.m_LODs):
                heights.append(float(lod.screenRelativeHeight))
                for r in lod.renderers:
                    pid = int(r.renderer.path_id)
                    if pid != 0:
                        memberships.append((pid, gi, li))
            p = lg.m_LocalReferencePoint
            groups.append({
                "pathId": int(o.path_id),
                "heights": heights,
                "size": float(lg.m_Size),
                "localReferencePoint": [float(p.x), float(p.y), float(p.z)],
                "enabled": bool(getattr(lg, "m_Enabled", True)),
            })

        # --- MeshRenderers ----------------------------------------------------
        R = {k: [] for k in ("mesh", "matrix", "enabled", "active", "has_transform",
                             "layer", "go_path", "cast_shadows", "path_id", "mat_start", "mat_count",
                             "static_batch", "lightmap")}
        mat_ids: list[int] = []
        mat_refs: list[int] = []
        for o in by_type.get("MeshRenderer", []):
            stats["renderers"] += 1
            mr = o.read()
            go = mr.m_GameObject.read()
            tr = go.m_Transform
            mf_ptr = go.m_MeshFilter
            mesh_id = -1
            if mf_ptr is not None:
                try:
                    mesh_id = ref_id(mf_ptr.read().m_Mesh)
                except Exception:  # noqa: BLE001
                    stats["meshfilter errors"] += 1
            has_tr = tr is not None and int(tr.path_id) in transforms
            pid = int(tr.path_id) if has_tr else None
            R["mesh"].append(mesh_id)
            R["matrix"].append(world(pid) if has_tr else np.eye(4))
            R["enabled"].append(bool(mr.m_Enabled))
            R["active"].append(is_active(pid) if has_tr else bool(go.m_IsActive))
            R["has_transform"].append(has_tr)
            R["layer"].append(int(go.m_Layer))
            R["go_path"].append(strings(hier_path(pid) if has_tr else go.m_Name))
            R["cast_shadows"].append(int(getattr(mr, "m_CastShadows", 1) or 0))
            R["path_id"].append(int(o.path_id))
            mats = [strings(self.material_name(p)) for p in (mr.m_Materials or [])]
            R["mat_start"].append(len(mat_ids))
            R["mat_count"].append(len(mats))
            mat_ids.extend(mats)
            mat_refs.extend(mat_id(p) for p in (mr.m_Materials or []))
            # Static batching: the referenced mesh is a world-space "Combined
            # Mesh"; this renderer draws only submeshes [first, first+count).
            sbi = getattr(mr, "m_StaticBatchInfo", None)
            R["static_batch"].append([int(sbi.firstSubMesh), int(sbi.subMeshCount)] if sbi is not None else [0, 0])
            R["lightmap"].append([int(getattr(mr, "m_LightmapIndex", 0xFFFF))]
                                 + _vec(getattr(mr, "m_LightmapTilingOffset", None) or _Zero4, 4))
        stats["skinned renderers (ignored)"] = len(by_type.get("SkinnedMeshRenderer", []))

        # --- Colliders --------------------------------------------------------
        C = {k: [] for k in ("kind", "matrix", "center", "size", "mesh", "enabled", "active", "trigger",
                             "convex", "layer", "go_path")}
        for type_name, kind in COLLIDER_KIND.items():
            for o in by_type.get(type_name, []):
                try:
                    c = o.read()
                    go = c.m_GameObject.read()
                    tr = go.m_Transform
                    has_tr = tr is not None and int(tr.path_id) in transforms
                    pid = int(tr.path_id) if has_tr else None
                    center = [0.0, 0.0, 0.0]
                    size = [0.0, 0.0, 0.0]
                    mesh_id = -1
                    if kind == 0:
                        center = [c.m_Center.x, c.m_Center.y, c.m_Center.z]
                        size = [c.m_Size.x, c.m_Size.y, c.m_Size.z]
                    elif kind == 1:
                        center = [c.m_Center.x, c.m_Center.y, c.m_Center.z]
                        size = [c.m_Radius, 0.0, 0.0]
                    elif kind == 2:
                        center = [c.m_Center.x, c.m_Center.y, c.m_Center.z]
                        size = [c.m_Radius, c.m_Height, float(c.m_Direction)]
                    else:
                        mesh_id = ref_id(c.m_Mesh)
                    C["kind"].append(kind)
                    C["matrix"].append(world(pid) if has_tr else np.eye(4))
                    C["center"].append(center)
                    C["size"].append(size)
                    C["mesh"].append(mesh_id)
                    C["enabled"].append(bool(c.m_Enabled))
                    C["active"].append(is_active(pid) if has_tr else bool(go.m_IsActive))
                    C["trigger"].append(bool(getattr(c, "m_IsTrigger", False)))
                    C["convex"].append(bool(getattr(c, "m_Convex", False)))
                    C["layer"].append(int(go.m_Layer))
                    C["go_path"].append(strings(hier_path(pid) if has_tr else go.m_Name))
                    stats[f"{type_name}"] += 1
                except Exception:  # noqa: BLE001
                    stats[f"{type_name} errors"] += 1

        # --- Terrains -----------------------------------------------------------
        arrays: dict[str, np.ndarray] = {}
        terrains = []
        for ti, o in enumerate(by_type.get("Terrain", [])):
            t = o.read()
            go = t.m_GameObject.read()
            tr = go.m_Transform
            has_tr = tr is not None and int(tr.path_id) in transforms
            pid = int(tr.path_id) if has_tr else None
            td = t.m_TerrainData.read()
            hm = td.m_Heightmap
            res = int(hm.m_Resolution)
            heights = np.asarray(hm.m_Heights, dtype=np.int32)
            if heights.size and heights.min() >= -32768 and heights.max() <= 32767:
                heights = heights.astype("<i2")
            arrays[f"terrain{ti}_heights"] = heights.reshape(res, res) if heights.size == res * res else heights
            holes = getattr(hm, "m_Holes", None)
            if holes is not None and len(holes):
                arrays[f"terrain{ti}_holes"] = np.asarray(holes, dtype=np.uint8)
            s = hm.m_Scale
            entry = {
                "name": td.m_Name or "",
                "goPath": hier_path(pid) if has_tr else go.m_Name,
                "enabled": bool(t.m_Enabled),
                "active": is_active(pid) if has_tr else bool(go.m_IsActive),
                "resolution": res,
                "scale": [float(s.x), float(s.y), float(s.z)],
                "matrix": (world(pid) if has_tr else np.eye(4)).reshape(-1).tolist(),
                "hasHoles": f"terrain{ti}_holes" in arrays,
                "treePrototypes": [],
            }
            try:
                entry["layers"], entry["splatMaps"] = self._terrain_splats(td, ti, arrays, tex_id, stats)
            except Exception as exc:  # noqa: BLE001
                stats["terrain splat errors"] += 1
                entry["splatError"] = f"{type(exc).__name__}: {exc}"[:200]
            try:
                dd = td.m_DetailDatabase
                protos, proto_parts = [], []
                for p in dd.m_TreePrototypes:
                    try:
                        protos.append(p.prefab.read().m_Name or "")
                        proto_parts.append(self._prefab_parts(p.prefab, ref_id, mat_id))
                    except Exception:  # noqa: BLE001
                        protos.append("")
                        proto_parts.append([])
                entry["treePrototypes"] = protos
                entry["treePrototypeParts"] = proto_parts
                trees = dd.m_TreeInstances
                if trees:
                    arrays[f"terrain{ti}_trees"] = np.array(
                        [[tt.position.x, tt.position.y, tt.position.z, tt.widthScale, tt.heightScale,
                          tt.rotation, tt.index] for tt in trees], dtype="<f4")
            except Exception:  # noqa: BLE001
                stats["terrain tree errors"] += 1
            terrains.append(entry)

        n = len(R["mesh"])
        arrays.update({
            "r_mesh": np.array(R["mesh"], "<i4"),
            "r_matrix": np.array(R["matrix"], "<f8").reshape(n, 4, 4),
            "r_enabled": np.array(R["enabled"], np.uint8),
            "r_active": np.array(R["active"], np.uint8),
            "r_has_transform": np.array(R["has_transform"], np.uint8),
            "r_layer": np.array(R["layer"], "<i2"),
            "r_go_path": np.array(R["go_path"], "<i4"),
            "r_cast_shadows": np.array(R["cast_shadows"], np.uint8),
            "r_path_id": np.array(R["path_id"], "<i8"),
            "r_mat_start": np.array(R["mat_start"], "<i4"),
            "r_mat_count": np.array(R["mat_count"], "<i2"),
            "r_materials": np.array(mat_ids, "<i4"),
            "r_material_ref": np.array(mat_refs, "<i4"),  # parallel to r_materials -> meta["materials"]
            "r_static_batch": np.array(R["static_batch"], "<i4").reshape(n, 2),
            "r_lightmap": np.array(R["lightmap"], "<f4").reshape(n, 5),  # index (65535: none), scale/offset
        })
        # LOD memberships -> renderer indices (-1: not a MeshRenderer, e.g. skinned).
        renderer_index = {pid: i for i, pid in enumerate(R["path_id"])}
        lm = np.array([(renderer_index.get(pid, -1), g, l) for pid, g, l in memberships], "<i4").reshape(-1, 3)
        arrays["lod_members"] = lm  # (K, 3): renderer, group, level - serialization order
        nc = len(C["kind"])
        arrays.update({
            "c_kind": np.array(C["kind"], np.uint8),
            "c_matrix": np.array(C["matrix"], "<f8").reshape(nc, 4, 4),
            "c_center": np.array(C["center"], "<f4").reshape(nc, 3),
            "c_size": np.array(C["size"], "<f4").reshape(nc, 3),
            "c_mesh": np.array(C["mesh"], "<i4"),
            "c_enabled": np.array(C["enabled"], np.uint8),
            "c_active": np.array(C["active"], np.uint8),
            "c_trigger": np.array(C["trigger"], np.uint8),
            "c_convex": np.array(C["convex"], np.uint8),
            "c_layer": np.array(C["layer"], "<i2"),
            "c_go_path": np.array(C["go_path"], "<i4"),
        })

        if materials:
            stats["materials"] = len(materials)
            stats["textures"] = len(textures)
        stats["lightmaps"] = sum(len(o.read().m_Lightmaps) for o in by_type.get("LightmapSettings", []))
        bad = Counter(r["status"] for r in refs if r["hash"] is None)
        meta = {
            "level": level,
            "scenePath": scene_path,
            "meshRefs": refs,
            "lodGroups": groups,
            "terrains": terrains,
            "materials": materials,
            "textures": textures,
            "strings": strings.values,
            "colliderKinds": {v: k for k, v in COLLIDER_KIND.items()},
            "stats": dict(sorted(stats.items())),
            "badMeshRefs": dict(bad),
        }
        elapsed = time.time() - t0
        return meta, arrays, elapsed

    # -- helpers for terrains / prefabs --------------------------------------

    def _terrain_splats(self, td, ti, arrays, tex_id, stats):
        sd = td.m_SplatDatabase
        layers = []
        for lp in getattr(sd, "m_TerrainLayers", None) or []:
            if int(lp.path_id) == 0:
                layers.append(None)
                continue
            tl = lp.read()
            layers.append({
                "name": tl.m_Name or "",
                "diffuse": tex_id(self.texture_info(tl.m_DiffuseTexture, thumb=True)),
                "normal": tex_id(self.texture_info(getattr(tl, "m_NormalMapTexture", None), thumb=False)),
                "tileSize": _vec(tl.m_TileSize, 2),
                "tileOffset": _vec(tl.m_TileOffset, 2),
                "specular": _vec(getattr(tl, "m_Specular", None) or _Zero4),
            })
        splats = []
        for k, ap in enumerate(getattr(sd, "m_AlphaTextures", None) or []):
            if int(ap.path_id) == 0:
                continue
            t = ap.read()
            rgba = _thumbnail(t, SPLAT_MAX)
            name = f"terrain{ti}_splat{k}"
            arrays[name] = rgba
            splats.append({"array": name, "width": int(t.m_Width), "height": int(t.m_Height)})
            stats["terrain splat maps"] += 1
        return layers, splats

    def _prefab_parts(self, root_pptr, ref_id, mat_id) -> list[dict]:
        """MeshRenderers in a prefab hierarchy, matrices relative to the root."""
        root = root_pptr.read()
        lod_level: dict[int, int] = {}
        parts = []

        def walk(go, parent_m, path):
            tr = go.m_Transform.read()
            m = parent_m @ local_matrix(tr) if path else np.eye(4)  # root at identity
            for comp in go.m_Components:
                if comp.type.name == "LODGroup":
                    lg = comp.read()
                    for li, lod in enumerate(lg.m_LODs):
                        for r in lod.renderers:
                            lod_level.setdefault(int(r.renderer.path_id), li)
            mr_ptr = go.m_MeshRenderer
            if mr_ptr is not None and go.m_MeshFilter is not None:
                mr = mr_ptr.read()
                parts.append({
                    "goPath": path or go.m_Name,
                    "mesh": ref_id(go.m_MeshFilter.read().m_Mesh),
                    "matrix": m.reshape(-1).tolist(),
                    "materials": [mat_id(p) for p in (mr.m_Materials or [])],
                    "enabled": bool(mr.m_Enabled),
                    "active": bool(go.m_IsActive),
                    "_pid": int(mr_ptr.path_id),
                })
            for c in tr.m_Children:
                child = c.read().m_GameObject.read()
                walk(child, m, f"{path}/{child.m_Name}" if path else child.m_Name)

        walk(root, np.eye(4), "")
        for p in parts:
            p["lod"] = lod_level.get(p.pop("_pid"), -1)
        return parts
