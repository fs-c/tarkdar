import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const PARAMS = new URLSearchParams(location.search);
const MODE = PARAMS.get("mode") || "overview";
const EXPLORE = MODE === "explore" || (PARAMS.get("map") || "").endsWith("-explore");
const INSPECT = MODE === "inspect";
let MAP = PARAMS.get("map");
if (!MAP) MAP = EXPLORE ? "customs-explore" : INSPECT ? "customs-inspect" : "customs";
if (EXPLORE) {
  if (MAP === "customs") MAP = "customs-explore";
  else if (MAP === "streets" || MAP === "streets-exterior") MAP = "streets-explore";
}
const BATCHED = PARAMS.get("batched") === "1";
const HYBRID = PARAMS.get("hybrid") === "1" && !INSPECT && !EXPLORE && !BATCHED;
const HYBRID_THRESHOLD = 20;
const HAS_INSPECT = MAP === "customs" || MAP === "customs-inspect" || MAP === "customs-explore";
const DATA_BASE = `/data/${MAP}`;
const DATA_FILE = MAP;

const $ = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat("en-US");

// ---------------------------------------------------------------------------
// Loading helpers
// ---------------------------------------------------------------------------

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  return res.json();
}

async function fetchBinary(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  const total = Number(res.headers.get("content-length")) || 0;
  if (!res.body) return { buffer: await res.arrayBuffer(), total };

  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    onProgress?.(received, total);
  }
  const buffer = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { buffer: buffer.buffer, total };
}

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------

const app = $("app");
const renderer = new THREE.WebGLRenderer({
  antialias: true,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const SKY = new THREE.Color(0x9aacbd);
scene.background = SKY;
scene.fog = new THREE.Fog(SKY, 900, 4200);

const camera = new THREE.PerspectiveCamera(
  55,
  window.innerWidth / window.innerHeight,
  0.5,
  30000,
);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.075;
controls.screenSpacePanning = false;
controls.minDistance = 4;
controls.maxDistance = 9000;
controls.maxPolarAngle = Math.PI * 0.495;

scene.add(new THREE.HemisphereLight(0xf4f7fb, 0x3a4650, 1.55));

const key = new THREE.DirectionalLight(0xfff3df, 2.25);
key.position.set(0.75, 1.4, 0.55).multiplyScalar(1000);
scene.add(key);

const fill = new THREE.DirectionalLight(0xbcd2e8, 0.65);
fill.position.set(-0.8, 0.6, -0.7).multiplyScalar(1000);
scene.add(fill);

// No textures in this spike. A few muted materials separate terrain,
// vegetation and built geometry so the shape reads without albedo maps.
const materials = {
  structure: new THREE.MeshStandardMaterial({ color: 0xb9c1c8, roughness: 0.93, metalness: 0.0 }),
  terrain: new THREE.MeshStandardMaterial({ color: 0x7d8a6f, roughness: 1.0, metalness: 0.0 }),
  foliage: new THREE.MeshStandardMaterial({ color: 0x5f724d, roughness: 1.0, metalness: 0.0 }),
  water: new THREE.MeshStandardMaterial({
    color: 0x5a7f90,
    roughness: 0.32,
    metalness: 0.0,
    transparent: true,
    opacity: 0.82,
  }),
  chunk: new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.93,
    metalness: 0.0,
    vertexColors: true,
  }),
  shadow: new THREE.MeshStandardMaterial({
    color: 0x3f4a55,
    roughness: 1.0,
    metalness: 0.0,
    transparent: true,
    opacity: 0.55,
  }),
  decal: new THREE.MeshStandardMaterial({ color: 0xd05a9a, roughness: 1.0, metalness: 0.0 }),
  background: new THREE.MeshStandardMaterial({ color: 0x3f8f9a, roughness: 1.0, metalness: 0.0 }),
};
const allMaterials = Object.values(materials);

const groups = {
  structure: new THREE.Group(),
  terrain: new THREE.Group(),
  foliage: new THREE.Group(),
  water: new THREE.Group(),
  chunk: new THREE.Group(),
  shadow: new THREE.Group(),
  decal: new THREE.Group(),
  background: new THREE.Group(),
};
for (const g of Object.values(groups)) scene.add(g);

const FOLIAGE_TOKENS = new Set([
  "tree", "pine", "birch", "ash", "filbert", "grass", "bush", "kust",
  "derevo", "foliage", "leaf", "oak", "maple", "willow", "poplar",
  "spruce", "fir", "elm", "linden", "cedar", "juniper", "shrub",
  "fern", "reed", "ivy",
]);

function isFoliage(name) {
  const lower = (name || "").toLowerCase();
  if (lower.startsWith("plant_wolf") || lower.includes("_plant_wolf")) return true;
  const tokens = lower.split(/[^a-z0-9]+/).filter(Boolean);
  const windowGlass = tokens.some((t) => ["window", "windows", "glass", "door", "doors", "gate", "gates",
                            "shutter", "shutters", "table", "tables", "locker", "cabinet"].includes(t));
  for (const tok of tokens) {
    for (const veg of FOLIAGE_TOKENS) {
      if (tok === veg) {
        if (veg === "leaf" && windowGlass) continue;
        return true;
      }
      if (tok.startsWith(veg) && /^\d+$/.test(tok.slice(veg.length))) {
        if (veg === "leaf" && windowGlass) continue;
        return true;
      }
    }
  }
  return false;
}
const TERRAIN_RE = /^terrain_|^custom_terrain|^plane\d*$|^plane_lod/i;
const WATER_TOKENS = new Set(["water", "river", "lake", "puddle", "pond", "sea", "ocean", "swamp"]);
const WATER_STRUCTURAL_TOKENS = new Set([
  "pipe", "pipes", "tank", "cistern", "storage", "filter", "facility",
  "cooler", "mixer", "cleaner", "well", "crane", "platform", "railings",
  "sump", "sewage", "window",
  "flotator", "decal",
]);

function isWater(name) {
  const lower = (name || "").toLowerCase();
  if (lower.includes("waterwell")) return false;
  if (lower.includes("water_for")) return true;
  const tokens = lower.split(/[^a-z0-9]+/).filter(Boolean);
  if (tokens.some((t) => WATER_STRUCTURAL_TOKENS.has(t))) return false;
  return tokens.some((t) => WATER_TOKENS.has(t)) || lower.startsWith("waterfor");
}
const SHADOW_RE = /shadow/i;
const DECAL_RE = /decal/i;
const BACKGROUND_RE = /background|backdrop|skybox/i;

function categoryFor(info) {
  if (info.kind === "chunk") return "chunk";
  const name = info.name || "";
  if (SHADOW_RE.test(name)) return "shadow";
  if (DECAL_RE.test(name)) return "decal";
  if (BACKGROUND_RE.test(name)) return "background";
  if (info.terrain || info.kind === "terrain") return "terrain";
  if (TERRAIN_RE.test(name)) return "terrain";
  if (isWater(name)) return "water";
  if (isFoliage(name)) return "foliage";
  return "structure";
}

let grid = null;
let view = { center: new THREE.Vector3(), radius: 1000 };

function makeGrid(bounds) {
  if (grid) {
    scene.remove(grid);
    grid.geometry.dispose();
    grid.material.dispose();
  }
  const min = new THREE.Vector3(...bounds.min);
  const max = new THREE.Vector3(...bounds.max);
  const span = Math.max(max.x - min.x, max.z - min.z) * 1.7;
  const divisions = Math.max(8, Math.min(160, Math.round(span / 100)));
  const size = divisions * 100;
  grid = new THREE.GridHelper(size, divisions, 0x33414d, 0x3c4b57);
  grid.position.set((min.x + max.x) / 2, min.y - 2, (min.z + max.z) / 2);
  grid.material.transparent = true;
  grid.material.opacity = 0.45;
  scene.add(grid);

  const scale = $("grid-scale");
  if (scale) scale.textContent = `grid ${Math.round(size / divisions)} m`;
}

function frameFromBounds(bounds) {
  const min = new THREE.Vector3(...bounds.min);
  const max = new THREE.Vector3(...bounds.max);
  const center = new THREE.Vector3().addVectors(min, max).multiplyScalar(0.5);
  const size = new THREE.Vector3().subVectors(max, min);
  const radius = Math.max(size.x, size.y, size.z);

  view = {
    center,
    radius,
    home: new THREE.Vector3(
      center.x + radius * 0.30,
      center.y + radius * 0.45,
      center.z + radius * 0.55,
    ),
    top: new THREE.Vector3(center.x, center.y + radius * 1.05, center.z + radius * 0.012),
  };

  controls.target.copy(center);
  camera.position.copy(view.home);
  camera.near = Math.max(0.5, radius / 5000);
  camera.far = radius * 22;
  camera.updateProjectionMatrix();
  controls.update();
}

// ---------------------------------------------------------------------------
// Build geometry
// ---------------------------------------------------------------------------

function makeGeometry(info, buffer, floatNormals = false) {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(buffer, info.positionOffset, info.vertexCount * 3);
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));

  if (info.normalOffset != null) {
    const int8 = info.normalType === "int8";
    let normals;
    if (int8 && floatNormals) {
      const src = new Int8Array(buffer, info.normalOffset, info.vertexCount * 3);
      normals = new Float32Array(src.length);
      for (let i = 0; i < src.length; i++) normals[i] = src[i] / 127;
    } else {
      normals = int8
        ? new Int8Array(buffer, info.normalOffset, info.vertexCount * 3)
        : new Float32Array(buffer, info.normalOffset, info.vertexCount * 3);
    }
    geometry.setAttribute(
      "normal",
      new THREE.BufferAttribute(normals, 3, int8 && !floatNormals),
    );
  }

  if (info.colorOffset != null) {
    const colors = new Uint8Array(buffer, info.colorOffset, info.vertexCount * 3);
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3, true));
  }

  const IndexArray = info.indexType === "uint32" ? Uint32Array : Uint16Array;
  const indices = new IndexArray(buffer, info.indexOffset, info.indexCount);
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));

  if (info.normalOffset == null) geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  return geometry;
}

const CATEGORY_COLORS = {
  structure: 0xb9c1c8,
  terrain: 0x7d8a6f,
  foliage: 0x5f724d,
  water: 0x5a7f90,
};

function buildBatchedMap(meta, buffer) {
  const used = new Set();
  for (const inst of meta.instances) used.add(inst.mesh);

  let maxVerts = 0;
  let maxIndices = 0;
  for (const mi of used) {
    const info = meta.meshes[mi];
    if (!info) continue;
    maxVerts += info.vertexCount;
    maxIndices += info.indexCount;
  }

  // Opaque batch (structures + terrain + foliage) and transparent water batch.
  const opaque = new THREE.BatchedMesh(
    meta.instances.length,
    maxVerts,
    maxIndices,
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.93, metalness: 0.0 }),
  );
  opaque.name = "batched-opaque";
  opaque.perObjectFrustumCulled = true;
  opaque.sortObjects = true;

  const water = new THREE.BatchedMesh(
    meta.instances.length,
    maxVerts,
    maxIndices,
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.32,
      metalness: 0.0,
      transparent: true,
      opacity: 0.82,
    }),
  );
  water.name = "batched-water";
  water.perObjectFrustumCulled = true;
  water.sortObjects = true;

  const geomIds = new Map();
  const infoByMesh = new Map();
  for (const mi of used) {
    const info = meta.meshes[mi];
    if (!info) continue;
    const cat = categoryFor(info);
    const target = cat === "water" ? water : opaque;
    const geometry = makeGeometry(info, buffer, true);
    geomIds.set(mi, { target, id: target.addGeometry(geometry) });
    infoByMesh.set(mi, info);
    geometry.dispose();
  }

  const matrix = new THREE.Matrix4();
  const color = new THREE.Color();
  for (const inst of meta.instances) {
    const entry = geomIds.get(inst.mesh);
    if (!entry) continue;
    const info = infoByMesh.get(inst.mesh);
    const iid = entry.target.addInstance(entry.id);
    matrix.fromArray(inst.matrix);
    entry.target.setMatrixAt(iid, matrix);
    color.setHex(CATEGORY_COLORS[categoryFor(info)]);
    entry.target.setColorAt(iid, color);
  }

  opaque.computeBoundingSphere();
  water.computeBoundingSphere();
  scene.add(opaque);
  if (water.instanceCount > 0) scene.add(water);

  const counts = { structure: 0, terrain: 0, foliage: 0, water: 0, chunk: 0 };
  for (const inst of meta.instances) {
    const info = infoByMesh.get(inst.mesh);
    if (info) counts[categoryFor(info)]++;
  }
  return counts;
}

const allInstancedMeshes = [];

function buildMap(meta, buffer) {
  const byMesh = new Map();
  for (let idx = 0; idx < meta.instances.length; idx++) {
    const inst = meta.instances[idx];
    let entry = byMesh.get(inst.mesh);
    if (!entry) byMesh.set(inst.mesh, (entry = { matrices: [], ids: [] }));
    entry.matrices.push(inst.matrix);
    entry.ids.push(idx);
  }

  const matrix = new THREE.Matrix4();
  const counts = { structure: 0, terrain: 0, foliage: 0, water: 0, chunk: 0 };
  // Rare mesh types are batched into a handful of draws. High-frequency
  // meshes stay instanced so their transforms keep using instanced attributes.
  const batched = { structure: new Map(), foliage: new Map(), water: new Map() };

  for (const [meshIndex, entry] of byMesh) {
    const info = meta.meshes[meshIndex];
    if (!info) continue;
    const category = categoryFor(info);

    if (HYBRID && category !== "terrain" && entry.matrices.length < HYBRID_THRESHOLD) {
      let matrices = batched[category].get(meshIndex);
      if (!matrices) batched[category].set(meshIndex, (matrices = []));
      matrices.push(...entry.matrices);
      counts[category] += entry.matrices.length;
      continue;
    }

    const matrices = entry.matrices;
    const geometry = makeGeometry(info, buffer);
    const inst = new THREE.InstancedMesh(geometry, materials[category], matrices.length);
    for (let i = 0; i < matrices.length; i++) {
      matrix.fromArray(matrices[i]);
      inst.setMatrixAt(i, matrix);
    }
    inst.instanceMatrix.needsUpdate = true;
    inst.computeBoundingSphere();
    inst.name = info.name;
    inst.userData.meshIndex = meshIndex;
    inst.userData.globalIds = entry.ids;
    groups[category].add(inst);
    allInstancedMeshes.push(inst);
    counts[category] += matrices.length;
  }

  for (const [category, meshMap] of Object.entries(batched)) {
    if (!meshMap.size) continue;

    let totalInstances = 0;
    let maxVerts = 0;
    let maxIndices = 0;
    for (const [meshIndex, matrices] of meshMap) {
      const info = meta.meshes[meshIndex];
      totalInstances += matrices.length;
      maxVerts += info.vertexCount;
      maxIndices += info.indexCount;
    }

    const mat = materials[category].clone();
    allMaterials.push(mat);
    const bm = new THREE.BatchedMesh(totalInstances, maxVerts, maxIndices, mat);
    bm.name = `batched-${category}`;
    bm.perObjectFrustumCulled = true;
    bm.sortObjects = category === "water";

    const geometryIds = new Map();
    for (const meshIndex of meshMap.keys()) {
      const info = meta.meshes[meshIndex];
      const geometry = makeGeometry(info, buffer, true);
      geometryIds.set(meshIndex, bm.addGeometry(geometry));
      geometry.dispose();
    }
    for (const [meshIndex, matrices] of meshMap) {
      const geometryId = geometryIds.get(meshIndex);
      for (const arr of matrices) {
        const instanceId = bm.addInstance(geometryId);
        matrix.fromArray(arr);
        bm.setMatrixAt(instanceId, matrix);
      }
    }
    bm.computeBoundingSphere();
    groups[category].add(bm);
  }

  return counts;
}

// ---------------------------------------------------------------------------
// Explore / strip-down mode
// ---------------------------------------------------------------------------
let exploreMeta = null;
let exploreBuffer = null;
let exploreInstanceMeta = [];
const exploreLocalBounds = new Map();
const exploreGeometryCache = new Map();
const exploreState = {
  categories: new Set(),
  sceneGroups: new Map(), // name -> { visible, instances, tris }
  minSize: 0,
  maxSize: 1e9,
  meshText: "",
  meshMode: "hide",
  hiddenMeshes: new Set(),
  soloMeshes: null,
};
let exploreVisibleStats = { instances: 0, tris: 0, meshes: 0 };
let exploreRebuildTimer = null;
let exploreUIReady = false;

function sceneGroupName(meta, sceneIndex) {
  const path = meta.sceneNames?.[sceneIndex] || meta.scenes?.[sceneIndex] || `scene ${sceneIndex}`;
  const cityArea = path.match(/City_Areas\/([^/]+)/i);
  if (cityArea) return cityArea[1];
  const base = path.split("/").pop() || path;
  return base.replace(/\.unity$/i, "");
}

function localBoundsFor(meshIndex) {
  let lb = exploreLocalBounds.get(meshIndex);
  if (lb) return lb;
  const info = exploreMeta.meshes[meshIndex];
  const pos = new Float32Array(exploreBuffer, info.positionOffset, info.vertexCount * 3);
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  lb = { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
  exploreLocalBounds.set(meshIndex, lb);
  return lb;
}

function computeExploreInstanceMeta(meta, buffer) {
  const m = new THREE.Matrix4();
  const corners = [
    [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
    [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
  ];
  const catCounts = {};
  const catTris = {};
  exploreState.sceneGroups = new Map();
  exploreInstanceMeta = new Array(meta.instances.length);

  for (let i = 0; i < meta.instances.length; i++) {
    const inst = meta.instances[i];
    const info = meta.meshes[inst.mesh];
    const cat = categoryFor(info);
    const tris = info.indexCount / 3;
    const lb = localBoundsFor(inst.mesh);
    m.fromArray(inst.matrix);

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const c of corners) {
      const x = lb.min[0] + (lb.max[0] - lb.min[0]) * c[0];
      const y = lb.min[1] + (lb.max[1] - lb.min[1]) * c[1];
      const z = lb.min[2] + (lb.max[2] - lb.min[2]) * c[2];
      const e = m.elements;
      const wx = e[0] * x + e[4] * y + e[8] * z + e[12];
      const wy = e[1] * x + e[5] * y + e[9] * z + e[13];
      const wz = e[2] * x + e[6] * y + e[10] * z + e[14];
      if (wx < minX) minX = wx;
      if (wx > maxX) maxX = wx;
      if (wy < minY) minY = wy;
      if (wy > maxY) maxY = wy;
      if (wz < minZ) minZ = wz;
      if (wz > maxZ) maxZ = wz;
    }
    const size = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
    const group = sceneGroupName(meta, inst.scene);

    catCounts[cat] = (catCounts[cat] || 0) + 1;
    catTris[cat] = (catTris[cat] || 0) + tris;
    let g = exploreState.sceneGroups.get(group);
    if (!g) {
      g = { visible: true, instances: 0, tris: 0 };
      exploreState.sceneGroups.set(group, g);
    }
    g.instances++;
    g.tris += tris;

    exploreInstanceMeta[i] = { mesh: inst.mesh, scene: inst.scene, cat, size, group };
  }
  return { catCounts, catTris };
}

function getExploreGeometry(meshIndex) {
  let geometry = exploreGeometryCache.get(meshIndex);
  if (!geometry) {
    geometry = makeGeometry(exploreMeta.meshes[meshIndex], exploreBuffer);
    exploreGeometryCache.set(meshIndex, geometry);
  }
  return geometry;
}

function filteredExploreIndices() {
  const st = exploreState;
  const text = st.meshText.trim().toLowerCase();
  const out = [];
  for (let i = 0; i < exploreInstanceMeta.length; i++) {
    const im = exploreInstanceMeta[i];
    if (!st.categories.has(im.cat)) continue;
    const group = st.sceneGroups.get(im.group);
    if (!group || !group.visible) continue;
    if (im.size < st.minSize || im.size > st.maxSize) continue;
    if (st.hiddenMeshes.has(im.mesh)) continue;
    if (st.soloMeshes && !st.soloMeshes.has(im.mesh)) continue;
    if (text) {
      const name = (exploreMeta.meshes[im.mesh].name || "").toLowerCase();
      const match = name.includes(text);
      if (st.meshMode === "hide" && match) continue;
      if (st.meshMode === "only" && !match) continue;
    }
    out.push(i);
  }
  return out;
}

function renderExploreStats() {
  const s = exploreVisibleStats;
  $("explore-visible").textContent = `${nf.format(s.instances)} inst`;
  $("explore-stats").textContent =
    `visible ${nf.format(s.instances)} instances · ${nf.format(s.tris)} tris · ` +
    `${nf.format(s.meshes)} mesh types`;
}

function rebuildExplore() {
  if (!exploreMeta) return;
  clearSelection();

  for (const group of Object.values(groups)) {
    for (const child of [...group.children]) {
      child.dispose?.();
      group.remove(child);
    }
  }
  allInstancedMeshes.length = 0;

  const indices = filteredExploreIndices();
  const byMesh = new Map();
  let tris = 0;
  for (const i of indices) {
    const im = exploreInstanceMeta[i];
    let entry = byMesh.get(im.mesh);
    if (!entry) byMesh.set(im.mesh, (entry = { matrices: [], ids: [] }));
    entry.matrices.push(exploreMeta.instances[i].matrix);
    entry.ids.push(i);
    tris += exploreMeta.meshes[im.mesh].indexCount / 3;
  }

  const matrix = new THREE.Matrix4();
  for (const [meshIndex, entry] of byMesh) {
    const info = exploreMeta.meshes[meshIndex];
    const category = categoryFor(info);
    const inst = new THREE.InstancedMesh(
      getExploreGeometry(meshIndex),
      materials[category],
      entry.matrices.length,
    );
    for (let i = 0; i < entry.matrices.length; i++) {
      matrix.fromArray(entry.matrices[i]);
      inst.setMatrixAt(i, matrix);
    }
    inst.instanceMatrix.needsUpdate = true;
    inst.computeBoundingSphere();
    inst.name = info.name;
    inst.userData.meshIndex = meshIndex;
    inst.userData.globalIds = entry.ids;
    groups[category].add(inst);
    allInstancedMeshes.push(inst);
  }

  exploreVisibleStats = { instances: indices.length, tris, meshes: byMesh.size };
  renderExploreStats();
}

function scheduleExploreRebuild() {
  clearTimeout(exploreRebuildTimer);
  exploreRebuildTimer = setTimeout(rebuildExplore, 120);
}

function exploreFilterReport() {
  const visibleScenes = [...exploreState.sceneGroups]
    .filter(([, g]) => g.visible)
    .map(([name]) => name);
  const hiddenNames = [...exploreState.hiddenMeshes]
    .map((mi) => exploreMeta?.meshes[mi]?.name)
    .filter(Boolean);
  const soloNames = exploreState.soloMeshes
    ? [...exploreState.soloMeshes].map((mi) => exploreMeta?.meshes[mi]?.name).filter(Boolean)
    : [];
  return JSON.stringify(
    {
      map: MAP,
      mode: "explore",
      generatedAt: new Date().toISOString(),
      categories: [...exploreState.categories],
      size: [exploreState.minSize, exploreState.maxSize],
      scenes: visibleScenes,
      meshName: { text: exploreState.meshText, mode: exploreState.meshMode },
      hiddenMeshes: hiddenNames,
      soloMeshes: soloNames,
      visible: exploreVisibleStats,
    },
    null,
    2,
  );
}

function updateExploreCheckboxes() {
  for (const input of document.querySelectorAll("#filter-categories input[data-category]")) {
    input.checked = exploreState.categories.has(input.dataset.category);
  }
  for (const input of document.querySelectorAll("#filter-scenes input[data-scene]")) {
    const group = exploreState.sceneGroups.get(input.dataset.scene);
    input.checked = group ? group.visible : true;
  }
  $("filter-min-size").value = exploreState.minSize;
  $("filter-max-size").value = exploreState.maxSize;
  $("filter-mesh-text").value = exploreState.meshText;
  $("filter-mesh-mode").value = exploreState.meshMode;
}

function initExploreUI(meta, catCounts, catTris) {
  const catList = $("filter-categories");
  catList.innerHTML = "";
  const order = ["structure", "terrain", "foliage", "water", "shadow", "decal", "background"];
  for (const cat of order) {
    if (!catCounts[cat]) continue;
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.dataset.category = cat;
    input.checked = exploreState.categories.has(cat);
    input.addEventListener("change", () => {
      if (input.checked) exploreState.categories.add(cat);
      else exploreState.categories.delete(cat);
      scheduleExploreRebuild();
    });
    const name = document.createElement("span");
    name.textContent = cat;
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = `${nf.format(catCounts[cat])} / ${nf.format(catTris[cat])} tri`;
    label.append(input, name, count);
    catList.append(label);
  }

  const sceneList = $("filter-scenes");
  sceneList.innerHTML = "";
  for (const [name, group] of [...exploreState.sceneGroups].sort((a, b) => a[0].localeCompare(b[0]))) {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.dataset.scene = name;
    input.checked = group.visible;
    input.addEventListener("change", () => {
      const g = exploreState.sceneGroups.get(name);
      if (g) g.visible = input.checked;
      scheduleExploreRebuild();
    });
    const text = document.createElement("span");
    text.textContent = name;
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = nf.format(group.instances);
    label.append(input, text, count);
    sceneList.append(label);
  }

  if (!exploreUIReady) {
    exploreUIReady = true;
    $("filter-min-size").addEventListener("input", () => {
      exploreState.minSize = Number($("filter-min-size").value) || 0;
      scheduleExploreRebuild();
    });
    $("filter-max-size").addEventListener("input", () => {
      exploreState.maxSize = Number($("filter-max-size").value) || 1e9;
      scheduleExploreRebuild();
    });
    $("filter-mesh-text").addEventListener("input", () => {
      exploreState.meshText = $("filter-mesh-text").value;
      scheduleExploreRebuild();
    });
    $("filter-mesh-mode").addEventListener("change", () => {
      exploreState.meshMode = $("filter-mesh-mode").value;
      scheduleExploreRebuild();
    });
    $("filter-apply").addEventListener("click", rebuildExplore);
    $("filter-huge").addEventListener("click", () => {
      exploreState.minSize = 100;
      exploreState.maxSize = 1e9;
      updateExploreCheckboxes();
      rebuildExplore();
    });
    $("filter-tiny").addEventListener("click", () => {
      exploreState.minSize = 0;
      exploreState.maxSize = 0.5;
      updateExploreCheckboxes();
      rebuildExplore();
    });
    $("filter-noise").addEventListener("click", () => {
      for (const c of ["shadow", "decal", "background"]) exploreState.categories.delete(c);
      updateExploreCheckboxes();
      rebuildExplore();
    });
    $("filter-reset").addEventListener("click", () => {
      exploreState.categories = new Set(Object.keys(catCounts));
      for (const g of exploreState.sceneGroups.values()) g.visible = true;
      exploreState.minSize = 0;
      exploreState.maxSize = 1e9;
      exploreState.meshText = "";
      exploreState.meshMode = "hide";
      exploreState.hiddenMeshes.clear();
      exploreState.soloMeshes = null;
      updateExploreCheckboxes();
      rebuildExplore();
    });
    $("filter-copy").addEventListener("click", async () => {
      const btn = $("filter-copy");
      const old = btn.textContent;
      await copyText(exploreFilterReport());
      btn.textContent = "Copied";
      setTimeout(() => (btn.textContent = old), 1200);
    });
  }
}

function buildExplore(meta, buffer) {
  exploreMeta = meta;
  exploreBuffer = buffer;
  exploreGeometryCache.clear();
  exploreLocalBounds.clear();
  exploreState.categories = new Set();
  exploreState.sceneGroups = new Map();
  exploreState.minSize = 0;
  exploreState.maxSize = 1e9;
  exploreState.meshText = "";
  exploreState.meshMode = "hide";
  exploreState.hiddenMeshes.clear();
  exploreState.soloMeshes = null;

  const { catCounts, catTris } = computeExploreInstanceMeta(meta, buffer);
  exploreState.categories = new Set(Object.keys(catCounts));
  initExploreUI(meta, catCounts, catTris);
  updateExploreCheckboxes();
  rebuildExplore();
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

let wireframe = false;
let vegVisible = true;

function toggleWireframe() {
  wireframe = !wireframe;
  for (const m of allMaterials) m.wireframe = wireframe;
  $("btn-wire").classList.toggle("active", wireframe);
}

function toggleGrid() {
  if (grid) grid.visible = !grid.visible;
  $("btn-grid").classList.toggle("active", grid?.visible ?? false);
}

function toggleVegetation() {
  vegVisible = !vegVisible;
  groups.foliage.visible = vegVisible;
  $("btn-veg").classList.toggle("active", vegVisible);
}

function resetView() {
  if (!view.home) return;
  camera.position.copy(view.home);
  controls.target.copy(view.center);
  controls.update();
}

function topView() {
  if (!view.top) return;
  camera.position.copy(view.top);
  controls.target.copy(view.center);
  controls.update();
}

$("btn-reset").addEventListener("click", resetView);
$("btn-top").addEventListener("click", topView);
$("btn-wire").addEventListener("click", toggleWireframe);
$("btn-grid").addEventListener("click", toggleGrid);
$("btn-veg").addEventListener("click", toggleVegetation);

window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement) return;
  const k = e.key.toLowerCase();
  if (k === "r") resetView();
  else if (k === "t") topView();
  else if (k === "f") toggleWireframe();
  else if (k === "g") toggleGrid();
  else if (k === "v") toggleVegetation();
});

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------------------------------------------------------------------
// Inspect-mode picker
// ---------------------------------------------------------------------------
let activeMeta = null;
let pickMode = INSPECT;
const selected = [];
const highlightGroup = new THREE.Group();
scene.add(highlightGroup);
const pickRaycaster = new THREE.Raycaster();
const pickPointer = new THREE.Vector2();
let pickDown = null;

function setPickMode(on) {
  pickMode = on;
  $("btn-pick").classList.toggle("active", pickMode);
  if (!pickMode) clearSelection();
}

function clearSelection() {
  selected.length = 0;
  renderSelection();
}

function meshIdsOfSelection() {
  return new Set(selected.map((s) => s.meshIndex));
}

function renderSelection() {
  const list = $("pick-list");
  list.innerHTML = "";
  for (const s of selected) {
    const li = document.createElement("li");
    const name = document.createElement("div");
    name.className = "pick-name";
    name.textContent = s.mesh;
    const meta = document.createElement("div");
    meta.className = "pick-meta";
    meta.textContent =
      `${s.category} · ${s.scene} · ${s.position.map((v) => v.toFixed(1)).join(", ")} · ` +
      `${s.size.map((v) => v.toFixed(1)).join("×")} m · ` +
      `scale ${s.scale.map((v) => v.toFixed(2)).join("×")} · ${nf.format(s.tris)} tris`;
    li.append(name, meta);
    list.append(li);
  }
  $("pick-count").textContent = String(selected.length);

  for (const child of [...highlightGroup.children]) {
    highlightGroup.remove(child);
    child.geometry.dispose();
    child.material.dispose();
  }
  for (const s of selected) {
    highlightGroup.add(new THREE.Box3Helper(s.box, 0xffcc33));
  }
}

function pickAt(clientX, clientY, additive) {
  if (!activeMeta) return;
  const rect = renderer.domElement.getBoundingClientRect();
  pickPointer.set(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
  pickRaycaster.setFromCamera(pickPointer, camera);
  const hits = pickRaycaster.intersectObjects(Object.values(groups), true);
  if (!hits.length) {
    if (!additive) clearSelection();
    return;
  }

  const hit = hits[0];
  const obj = hit.object;
  if (!obj.isInstancedMesh || !obj.userData.globalIds) return;
  const globalId = obj.userData.globalIds[hit.instanceId];
  if (globalId == null) return;
  const inst = activeMeta.instances[globalId];
  const meshIndex = obj.userData.meshIndex;
  const info = activeMeta.meshes[meshIndex];
  const category = categoryFor(info);
  const matrix = new THREE.Matrix4().fromArray(inst.matrix);
  const box = new THREE.Box3().copy(obj.geometry.boundingBox).applyMatrix4(matrix);
  const size = box.getSize(new THREE.Vector3());
  const e = matrix.elements;
  const scale = [
    Math.hypot(e[0], e[1], e[2]),
    Math.hypot(e[4], e[5], e[6]),
    Math.hypot(e[8], e[9], e[10]),
  ];

  if (!additive) selected.length = 0;
  if (!selected.some((s) => s.globalId === globalId)) {
    selected.push({
      globalId,
      meshIndex,
      mesh: info.name,
      category,
      scene: activeMeta.scenes?.[inst.scene] ?? `scene ${inst.scene}`,
      sceneIndex: inst.scene,
      position: [matrix.elements[12], matrix.elements[13], matrix.elements[14]],
      size: [size.x, size.y, size.z],
      scale,
      tris: info.indexCount / 3,
      box,
    });
    if (selected.length > 30) selected.shift();
  }
  renderSelection();
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

function reportJson() {
  return JSON.stringify(
    {
      map: MAP,
      mode: MODE,
      generatedAt: new Date().toISOString(),
      selection: selected.map((s) => ({
        mesh: s.mesh,
        meshIndex: s.meshIndex,
        category: s.category,
        scene: s.scene,
        sceneIndex: s.sceneIndex,
        instance: s.globalId,
        position: s.position.map((v) => Number(v.toFixed(2))),
        size: s.size.map((v) => Number(v.toFixed(2))),
        scale: s.scale.map((v) => Number(v.toFixed(3))),
        triangles: s.tris,
      })),
    },
    null,
    2,
  );
}

function hideSelectedMeshes() {
  const ids = meshIdsOfSelection();
  if (EXPLORE) {
    for (const id of ids) exploreState.hiddenMeshes.add(id);
    scheduleExploreRebuild();
    return;
  }
  for (const mesh of allInstancedMeshes) {
    if (ids.has(mesh.userData.meshIndex)) mesh.visible = false;
  }
}

function soloSelectedMeshes() {
  const ids = meshIdsOfSelection();
  if (EXPLORE) {
    exploreState.soloMeshes = new Set(ids);
    scheduleExploreRebuild();
    return;
  }
  for (const mesh of allInstancedMeshes) {
    mesh.visible = ids.has(mesh.userData.meshIndex);
  }
}

function showAllMeshes() {
  if (EXPLORE) {
    exploreState.hiddenMeshes.clear();
    exploreState.soloMeshes = null;
    scheduleExploreRebuild();
    return;
  }
  for (const mesh of allInstancedMeshes) mesh.visible = true;
}

function updateModeUI(meta) {
  const pickerActive = INSPECT || EXPLORE;
  $("btn-pick").style.display = pickerActive ? "" : "none";
  $("picker").hidden = !pickerActive;
  $("picker").style.display = pickerActive ? "" : "none";
  $("explore-panel").hidden = !EXPLORE;
  $("btn-mode").style.display = !EXPLORE && HAS_INSPECT ? "" : "none";
  $("btn-mode").textContent = INSPECT ? "Overview" : "Inspect";
  $("btn-explore").style.display = INSPECT ? "none" : "";
  $("btn-explore").textContent = EXPLORE ? "Overview" : "Explore";

  const title = document.querySelector(".hud-top-left h1");
  if (EXPLORE) {
    if (title) {
      title.firstChild.nodeValue = `${meta.label || MAP} explore `;
      const tag = title.querySelector("span");
      if (tag) tag.textContent = "EXPLORE";
    }
    document.querySelector(".sub").textContent =
      "Explore mode · start full, strip categories/scenes/size";
    setPickMode(true);
    renderSelection();
  } else if (INSPECT) {
    document.querySelector(".sub").textContent =
      "Inspect mode · click objects to identify · LOD0 data";
    setPickMode(true);
    renderSelection();
  }
  if (meta.baked) {
    $("btn-veg").style.display = "none";
  }
}

let selectValue = MAP;
if (MAP === "customs-inspect" || MAP === "customs-explore") selectValue = "customs";
if (MAP === "streets-explore") selectValue = "streets";
$("map-select").value = selectValue;
if (EXPLORE) {
  const ext = $("map-select").querySelector('option[value="streets-exterior"]');
  if (ext) ext.disabled = true;
}
$("map-select").addEventListener("change", (e) => {
  const value = e.target.value;
  if (EXPLORE) {
    const map = value === "streets-exterior" ? "streets" : value;
    location.href = `${location.pathname}?mode=explore&map=${encodeURIComponent(map)}`;
  } else {
    location.href = `${location.pathname}?map=${encodeURIComponent(value)}`;
  }
});

$("btn-explore").addEventListener("click", () => {
  const map = MAP.startsWith("streets") ? "streets" : "customs";
  location.href = EXPLORE
    ? `${location.pathname}?map=${map}`
    : `${location.pathname}?mode=explore&map=${map}`;
});

$("btn-pick").addEventListener("click", () => setPickMode(!pickMode));
$("btn-mode").addEventListener("click", () => {
  location.href = INSPECT ? location.pathname : `${location.pathname}?mode=inspect`;
});
$("pick-copy").addEventListener("click", async () => {
  const btn = $("pick-copy");
  const old = btn.textContent;
  const ok = await copyText(reportJson());
  btn.textContent = ok ? "Copied" : "Copy failed";
  setTimeout(() => (btn.textContent = old), 1200);
});
$("pick-download").addEventListener("click", () => {
  const blob = new Blob([reportJson()], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `selection-${MAP}.json`;
  a.click();
  URL.revokeObjectURL(url);
});
$("pick-clear").addEventListener("click", clearSelection);
$("pick-hide").addEventListener("click", hideSelectedMeshes);
$("pick-solo").addEventListener("click", soloSelectedMeshes);
$("pick-showall").addEventListener("click", showAllMeshes);

renderer.domElement.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  pickDown = { x: e.clientX, y: e.clientY, t: performance.now() };
});
renderer.domElement.addEventListener("pointerup", (e) => {
  if (!pickDown || e.button !== 0) return;
  const moved = Math.hypot(e.clientX - pickDown.x, e.clientY - pickDown.y);
  const elapsed = performance.now() - pickDown.t;
  pickDown = null;
  if (!(INSPECT || EXPLORE) || !pickMode) return;
  if (moved > 6 || elapsed > 700) return;
  pickAt(e.clientX, e.clientY, e.shiftKey);
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") clearSelection();
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  const loader = $("loader");
  const text = $("loader-text");
  const sub = $("loader-sub");
  const fill = $("bar-fill");

  try {
    text.textContent = "Loading metadata…";
    const meta = await fetchJson(`${DATA_BASE}/${DATA_FILE}.json`);

    const title = document.querySelector(".hud-top-left h1");
    if (title) {
      title.firstChild.nodeValue = `${meta.label || MAP} `;
      const tag = title.querySelector("span");
      if (tag) {
        tag.textContent = meta.tag || "";
        tag.style.display = meta.tag ? "" : "none";
      }
    }
    $("stat-unique").textContent = nf.format(meta.stats.uniqueTriangles);
    $("stat-instanced").textContent = nf.format(meta.stats.instancedTriangles);
    if (meta.baked) {
      $("stat-instances-label").textContent = "chunks";
      $("stat-instances").textContent = nf.format(meta.stats.chunkCount);
      $("btn-veg").style.display = "none";
    } else {
      $("stat-instances").textContent = nf.format(meta.stats.instanceCount);
    }

    text.textContent = "Downloading geometry…";
    const { buffer } = await fetchBinary(`${DATA_BASE}/${DATA_FILE}.bin`, (received, total) => {
      if (total) {
        fill.style.width = `${Math.min(100, (received / total) * 100)}%`;
        sub.textContent = `${(received / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB`;
      }
    });

    text.textContent = "Building meshes…";
    sub.textContent = `${meta.stats.meshCount} unique meshes · ${meta.stats.instanceCount} instances`;
    fill.style.width = "100%";

    await new Promise((r) => requestAnimationFrame(() => r()));

    const t0 = performance.now();
    let counts;
    if (EXPLORE) {
      buildExplore(meta, buffer);
      counts = { explore: exploreVisibleStats.instances };
    } else {
      counts = BATCHED ? buildBatchedMap(meta, buffer) : buildMap(meta, buffer);
    }
    const ms = performance.now() - t0;

    const focus = meta.focusBounds || meta.bounds;
    makeGrid(focus);
    frameFromBounds(focus);

    // The initial camera is set for the playable core; fog is tuned to it.
    scene.fog.near = view.radius * 0.7;
    scene.fog.far = view.radius * 3.2;

    activeMeta = meta;
    updateModeUI(meta);

    const total = EXPLORE ? exploreVisibleStats.instances : Object.values(counts).reduce((a, b) => a + b, 0);
    sub.textContent = `${nf.format(total)} ${meta.baked ? "chunks" : "instances"} built in ${ms.toFixed(0)} ms`;
    loader.classList.add("hidden");
    setTimeout(() => loader.remove(), 600);

    window.__map = { THREE, scene, camera, renderer, controls, materials, groups, view, meta };
  } catch (err) {
    console.error(err);
    text.textContent = "Failed to load map data";
    sub.textContent = String(err.message || err);
    fill.style.width = "0%";
    fill.style.background = "#c25b4e";
  }
}

const perfEl = $("perf");
let last = performance.now();
let frames = 0;

renderer.setAnimationLoop(() => {
  const now = performance.now();
  frames++;
  if (now - last >= 500) {
    const fps = (frames * 1000) / (now - last);
    frames = 0;
    last = now;
    perfEl.textContent = `${fps.toFixed(0)} fps · ${nf.format(renderer.info.render.calls)} calls · ${nf.format(
      renderer.info.render.triangles,
    )} tris`;
  }
  controls.update();
  renderer.render(scene, camera);
});

boot();
