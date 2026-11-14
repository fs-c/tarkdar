// Renderer, camera, controls and the per-category materials of the 3D map. Nothing here renders
// on its own: Map3D asks for a frame when something changed.
//
// A frame is drawn in one of two ways. Directly: the whole scene, as any 3D view. Or, when the
// view is orthographic and straight down (the view during a raid), from tiles: a picture of the
// map painted once and then only moved and turned (tiles.ts, and "Tiles" below).

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { Bounds } from "./dataset";
import type { GroundMap } from "./dataset";
import { COLOR_SCHEMES, type ColorGrade, PLAN_PALETTES, type PlanPalette } from "./settings";
import { type FlatView, type Painter, snapShift, TileCache } from "./tiles";

interface CategoryLook {
  color: number;
  roughness: number;
  opacity?: number;
}

const LOOKS: Record<string, CategoryLook> = {
  structure: { color: 0xb9c1c8, roughness: 0.93 },
  terrain: { color: 0x7d8a6f, roughness: 1.0 },
  foliage: { color: 0x6c8a5e, roughness: 1.0, opacity: 0.6 }, // tree markers: see-through
  water: { color: 0x5a7f90, roughness: 0.32, opacity: 0.82 },
  glass: { color: 0x7f97a8, roughness: 0.25 }, // solid: there are no interiors behind it
  shadow: { color: 0x3f4a55, roughness: 1.0, opacity: 0.55 },
  decal: { color: 0xd05a9a, roughness: 1.0 },
  background: { color: 0x3f8f9a, roughness: 1.0 },
  road: { color: 0x8f9296, roughness: 1.0 },
};
const FALLBACK_LOOK: CategoryLook = { color: 0xb9c1c8, roughness: 0.93 };

/** Contour interval of the terrain in metres (every fifth line is stronger). */
const CONTOUR_INTERVAL = 2;

/** Narrow, so buildings barely lean over the streets in the top-down view. */
const FIELD_OF_VIEW = 25;
const HALF_FOV_TAN = Math.tan(THREE.MathUtils.degToRad(FIELD_OF_VIEW / 2));

/** Closest zoom: metres of ground across the height of the view. */
const MIN_SPAN = 6.6;
/** Farthest zoom, in map sizes. */
const MAX_SPAN_FACTOR = 2.5;

// Tiles (tiles.ts).
/** Tilted less than this (radians) the view counts as straight down: a 50 m tower leans by 10 cm. */
const FLAT_TILT = 2e-3;
/** After the zoom or the look of the map changed, tiles are painted once it has stayed the same for this long (ms). */
const SETTLE = 120;
/** A view that moves more than this many device pixels in a frame outruns the tiles: none are painted until it has been slower for CALM ms. */
const FAST = 48;
const CALM = 150;
/** Tiles painted in a frame: within a frame that needs them to show the view, and between frames. */
const PAINT_NOW = 2;
const PAINT_AHEAD = 2;
/** The direct rendering's own buffers are given back once frames have come from tiles for this long (ms). */
const IDLE_TARGET = 3000;

interface Uniforms {
  heights: { value: THREE.Vector2 };
  contours: { value: number };
  /** lift, contrast, saturation, ground saturation (settings.ts ColorGrade). */
  grade: { value: THREE.Vector4 };
  /** 1 = plan style (settings.ts MapStyle). */
  plan: { value: number };
  /** Ground height per cell (dataset GroundMap), and where it lies: x0, z0, cells per metre. */
  ground: { value: THREE.Texture };
  groundRect: { value: THREE.Vector3 };
  /** 1 where a building stands (GroundMap.building), on the same grid. */
  building: { value: THREE.Texture };
  /** Nothing is drawn above this height (Stage.setFloor); very high: no cut. */
  cut: { value: number };
  /** The floor being looked at: the plan style's ground on an interior map; very low: the ground map. */
  floor: { value: number };
  /** PALETTE_KEYS colours, sRGB. */
  palette: { value: THREE.Vector3[] };
  /** Texels per device pixel: more than 1 while a tile is painted larger than it is shown. */
  texels: { value: number };
}

/** What a surface is in the plan style. */
type PlanKind = "structure" | "terrain" | "water" | "tree" | "road";

const NO_CUT = 1e9;
/** The cut lies this far above the floor being looked at: over heads and door frames, under the ceiling. */
export const CUT_ABOVE_FLOOR = 2.3;

interface ShaderOptions {
  /** Game colours -> map colours (ColorGrade). */
  grade?: boolean;
  /** The colour is a ground image: the ground saturation applies as well. */
  ground?: boolean;
  /** Terrain relief: slope shading, height tint, contour lines. */
  relief?: boolean;
  /** How the plan style colours it; without it the surface looks the same in both styles. */
  plan?: PlanKind;
}

// The grade works on sRGB values (as the build's colour statistics do); the shader's colours are
// linear. Very dark colours have no usable hue, so they are blended with grey instead of being
// multiplied up.
const GRADE_PARS = `
uniform vec4 uGrade;
vec3 mapToSrgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
vec3 mapToLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 mapGrade(vec3 linear, float saturation) {
  const vec3 W = vec3(0.2126, 0.7152, 0.0722);
  vec3 c = mapToSrgb(clamp(linear, 0.0, 1.0));
  float luma = dot(c, W);
  float target = uGrade.x + uGrade.y * luma;
  float hue = min(1.0, luma / 0.12);
  c = min(vec3(1.0), hue * c * (target / max(luma, 1e-3)) + (1.0 - hue) * target);
  c = clamp(mix(vec3(dot(c, W)), c, saturation), 0.0, 1.0);
  return mapToLinear(c);
}`;

const RELIEF = `
  float level = clamp((vMapWorld.y - uHeights.x) / max(uHeights.y - uHeights.x, 1.0), 0.0, 1.0);
  // The plan style keeps a hint of the relief: its ground colours are meant to be flat.
  float relief = 1.0 - 0.7 * uPlan;
  diffuseColor.rgb *= mix(vec3(1.0), mix(vec3(0.78, 0.86, 0.84), vec3(1.16, 1.12, 0.98), level), relief);
  diffuseColor.rgb *= mix(1.0, mix(0.62, 1.0, smoothstep(0.75, 0.99, vMapUp)), relief);
  float c = vMapWorld.y / ${CONTOUR_INTERVAL.toFixed(1)};
  // Per device pixel, so the lines are as wide in a tile painted larger than it is shown.
  float wMinor = fwidth(c) * uTexels;
  float wMajor = fwidth(c / 5.0) * uTexels;
  float minor = 1.0 - smoothstep(0.0, 1.2, abs(fract(c - 0.5) - 0.5) / wMinor);
  float major = 1.0 - smoothstep(0.0, 1.6, abs(fract(c / 5.0 - 0.5) - 0.5) / wMajor);
  // No lines on nearly level ground (height noise would speckle it), and lines fade out
  // once they are closer together than a few pixels.
  float sloped = smoothstep(0.0004, 0.003, 1.0 - vMapUp);
  minor *= sloped * (1.0 - smoothstep(0.15, 0.4, wMinor));
  major *= sloped * (1.0 - smoothstep(0.15, 0.4, wMajor));
  diffuseColor.rgb *= 1.0 - uContours * (0.16 * minor + 0.22 * major);`;

// The plan style: what a hand-drawn map does. Few flat colours that say what a thing is rather
// than what it is made of, so that buildings, cover and open ground separate at a glance:
//   structure  by height above the ground (uGround): at floor level one colour varied a little
//              by the material (pavements, slabs), then one for low obstacles (cars, fences,
//              crates: cover), then one for what is taller than a person, or the building colour
//   terrain    two flat colours, grass or bare ground, from the ground image
//   road, water, trees: one colour each
// The colours are the palette's (settings.ts PlanPalette, sRGB), shown as they are: the plan
// style replaces the material's lighting with a shade of its own that is 1 on a level surface,
// and is not tone mapped. The outlines come from the depth buffer afterwards (OUTLINE_FRAGMENT).
const PALETTE_KEYS = ["ground", "grass", "road", "water", "floor", "cover", "obstacle", "building", "buildingTall", "tree"] as const;
const PAL = Object.fromEntries(PALETTE_KEYS.map((key, i) => [key, `uPalette[${i}]`])) as Record<(typeof PALETTE_KEYS)[number], string>;

const PLAN_PARS = `
uniform float uPlan;
uniform float uFloor;
uniform sampler2D uGround;
uniform sampler2D uBuilding;
uniform vec3 uGroundRect;
uniform vec3 uPalette[${PALETTE_KEYS.length}];
const vec3 PLAN_W = vec3(0.2126, 0.7152, 0.0722);
vec3 mapPlanColor;
float mapGround(vec2 xz) {
  // Bilinear by hand: float textures cannot be filtered everywhere.
  vec2 p = (xz - uGroundRect.xy) * uGroundRect.z - 0.5;
  vec2 f = fract(p);
  ivec2 last = textureSize(uGround, 0) - 1;
  ivec2 a = clamp(ivec2(floor(p)), ivec2(0), last);
  ivec2 b = min(a + 1, last);
  float h00 = texelFetch(uGround, a, 0).r;
  float h10 = texelFetch(uGround, ivec2(b.x, a.y), 0).r;
  float h01 = texelFetch(uGround, ivec2(a.x, b.y), 0).r;
  float h11 = texelFetch(uGround, b, 0).r;
  return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
}
vec3 planStructure(vec3 graded) {
  // Looking at a floor of a cut-open map: heights count from that floor, and nothing is a roof.
  bool inside = uFloor > -1e4;
  float h = vMapWorld.y - (inside ? uFloor : mapGround(vMapWorld.xz));
  vec2 cell = (vMapWorld.xz - uGroundRect.xy) * uGroundRect.z;
  float building = inside ? 0.0 : smoothstep(0.3, 0.6, texture2D(uBuilding, cell / vec2(textureSize(uBuilding, 0))).r);
  float luma = dot(mapToSrgb(graded), PLAN_W);
  vec3 roof = mix(${PAL.building}, ${PAL.buildingTall}, smoothstep(3.0, 24.0, h));
  vec3 c = mix(${PAL.floor} + 0.3 * (luma - 0.6), ${PAL.cover}, smoothstep(0.3, 0.5, h));
  c = mix(c, mix(${PAL.obstacle}, roof, building), smoothstep(1.8, 2.2, h));
  // What lies below the floor (seen through a stairwell, from a gallery) recedes.
  if (inside) c *= mix(0.72, 1.0, smoothstep(-1.2, -0.6, h));
  return mapToLinear(clamp(c, 0.0, 1.0));
}
vec3 planRoad(vec3 graded) {
  // A little lighter for sand and slabs than for asphalt.
  float luma = dot(mapToSrgb(graded), PLAN_W);
  return mapToLinear(clamp(${PAL.road} + 0.2 * (luma - 0.6), 0.0, 1.0));
}
vec3 planTerrain(vec3 image) {
  vec3 t = mapToSrgb(image);
  float luma = max(dot(t, PLAN_W), 1e-3);
  float grass = smoothstep(0.0, 0.06, (t.g - t.r) / luma);
  return mapToLinear(mix(${PAL.ground}, ${PAL.grass}, grass));
}
// 1 on a level surface, darker on walls, which differ a little by the way they face.
float planShade() {
  vec3 n = normalize(cross(dFdx(vMapWorld), dFdy(vMapWorld)));
  float up = abs(n.y);
  return 0.74 + 0.26 * up + 0.1 * (1.0 - up) * (0.8 * n.x + 0.6 * n.z);
}`;

const PLAN_STEPS: Record<PlanKind, string> = {
  structure: "\nif (uPlan > 0.5) diffuseColor.rgb = planStructure(diffuseColor.rgb);",
  terrain: "\nif (uPlan > 0.5) diffuseColor.rgb = planTerrain(mapRaw);",
  water: `\nif (uPlan > 0.5) diffuseColor = vec4(mapToLinear(${PAL.water}), 1.0);`,
  tree: `\nif (uPlan > 0.5) diffuseColor.rgb = mapToLinear(${PAL.tree});`,
  road: "\nif (uPlan > 0.5) diffuseColor.rgb = planRoad(diffuseColor.rgb);",
};
/** Terrain keeps its smooth relief shading (RELIEF); everything else is shaded per face. */
const PLAN_OUTPUT: Record<PlanKind, string> = {
  structure: "mapPlanColor * planShade()",
  terrain: "mapPlanColor",
  water: "mapPlanColor",
  tree: "mapPlanColor * planShade()",
  road: "mapPlanColor",
};

/**
 * Adds the map's own steps to a standard material, after its base colour is known: the colour
 * grade, then the terrain relief (darker steep slopes, a tint from low (cooler, darker) to high
 * (warmer, lighter) ground, contour lines).
 */
function customize(material: THREE.MeshStandardMaterial, uniforms: Uniforms, options: ShaderOptions): void {
  const { grade = false, ground = false, relief = false, plan } = options;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uCut = uniforms.cut;
    shader.uniforms.uFloor = uniforms.floor;
    shader.uniforms.uHeights = uniforms.heights;
    shader.uniforms.uContours = uniforms.contours;
    shader.uniforms.uGrade = uniforms.grade;
    shader.uniforms.uPlan = uniforms.plan;
    shader.uniforms.uGround = uniforms.ground;
    shader.uniforms.uGroundRect = uniforms.groundRect;
    shader.uniforms.uBuilding = uniforms.building;
    shader.uniforms.uPalette = uniforms.palette;
    shader.uniforms.uTexels = uniforms.texels;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vMapWorld;\nvarying float vMapUp;")
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vMapWorld = (modelMatrix * instanceMatrix * vec4(position, 1.0)).xyz;
        #else
          vMapWorld = (modelMatrix * vec4(position, 1.0)).xyz;
        #endif
        vMapUp = normal.y;`,
      );
    const pars =
      "\nvarying vec3 vMapWorld;\nvarying float vMapUp;\nuniform vec2 uHeights;\nuniform float uContours;\nuniform float uCut;\nuniform float uTexels;" +
      GRADE_PARS +
      PLAN_PARS;
    const steps =
      "\nif (vMapWorld.y > uCut) discard;" +
      "\nvec3 mapRaw = diffuseColor.rgb;" +
      (grade ? `\ndiffuseColor.rgb = mapGrade(diffuseColor.rgb, uGrade.z${ground ? " * uGrade.w" : ""});` : "") +
      (plan ? PLAN_STEPS[plan] : "") +
      (relief ? RELIEF : "") +
      "\nmapPlanColor = diffuseColor.rgb;";
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>${pars}`)
      .replace("#include <color_fragment>", `#include <color_fragment>${steps}`);
    if (plan) {
      // The plan style's own colour instead of the lit one.
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <dithering_fragment>",
        `#include <dithering_fragment>\nif (uPlan > 0.5) gl_FragColor.rgb = ${PLAN_OUTPUT[plan]};`,
      );
    }
  };
  material.customProgramCacheKey = () => `map-${+grade}${+ground}${+relief}-${plan ?? ""}`;
}

// The outlines of the plan style, drawn over the finished image from its depth buffer: a line
// wherever the surface steps towards or away from the viewer by more than a few decimetres (a
// roof edge against the street, a wall, a car), darker the higher the step. Depth-buffer values
// of a plane are linear across the screen in both projections, so their second difference is
// zero on any flat surface however it is tilted, and is the step in depth at an edge. The
// difference is taken across one device pixel (uTexel), which is several texels when a tile is
// painted larger than it is shown: the lines are as wide there, with soft edges.
const OUTLINE_VERTEX = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const OUTLINE_FRAGMENT = `
uniform sampler2D tColor;
uniform sampler2D tDepth;
/** A device pixel in texture coordinates. */
uniform vec2 uTexel;
/** near, far, 1 = orthographic. */
uniform vec3 uClip;
/** Metres across a pixel: at depth 1 in perspective, anywhere in a parallel projection. */
uniform float uPixel;
uniform vec3 uBackground;
uniform vec3 uLine;
varying vec2 vUv;
void main() {
  vec4 color = texture2D(tColor, vUv);
  float d = texture2D(tDepth, vUv).x;
  float l = texture2D(tDepth, vUv - vec2(uTexel.x, 0.0)).x;
  float r = texture2D(tDepth, vUv + vec2(uTexel.x, 0.0)).x;
  float b = texture2D(tDepth, vUv - vec2(0.0, uTexel.y)).x;
  float t = texture2D(tDepth, vUv + vec2(0.0, uTexel.y)).x;
  float bend = max(abs(l + r - 2.0 * d), abs(b + t - 2.0 * d));
  float near = uClip.x, far = uClip.y;
  float z = near * far / (far - d * (far - near));
  bool parallel = uClip.z > 0.5;
  float metres = bend * (parallel ? far - near : z * z * (far - near) / (near * far));
  // A crease or a curved surface (terrain) bends by an amount that grows with the ground a
  // pixel covers, a step does not: so the threshold grows with it. Zoomed in, kerbs get a faint
  // line; zoomed out, only buildings and walls do.
  float pixel = parallel ? uPixel : uPixel * z;
  float edge = smoothstep(0.1 + 0.4 * pixel, 0.3 + 0.8 * pixel, metres) * mix(0.25, 0.8, smoothstep(0.4, 4.0, metres));
  gl_FragColor = vec4(mix(d >= 1.0 ? uBackground : color.rgb, uLine, edge), 1.0);
  #include <colorspace_fragment>
}`;

// A tile of the realistic style is painted as the screen would be (tone mapped, sRGB values):
// this copies it into the tile's texture, which holds linear colours.
const COPY_FRAGMENT = `
uniform sampler2D tColor;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tColor, vUv).rgb;
  gl_FragColor = vec4(mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)), 1.0);
}`;

const PLAN_KINDS: Record<string, PlanKind | undefined> = {
  structure: "structure",
  glass: "structure",
  terrain: "terrain",
  water: "water",
  foliage: "tree",
  road: "road",
};

function groundTexture(heights: Float32Array, columns: number, rows: number): THREE.DataTexture {
  const texture = new THREE.DataTexture(heights, columns, rows, THREE.RedFormat, THREE.FloatType);
  texture.needsUpdate = true;
  return texture;
}

function buildingTexture(mask: Uint8Array, columns: number, rows: number): THREE.DataTexture {
  const texture = new THREE.DataTexture(mask, columns, rows, THREE.RedFormat, THREE.UnsignedByteType);
  texture.magFilter = texture.minFilter = THREE.LinearFilter;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly perspective = new THREE.PerspectiveCamera(FIELD_OF_VIEW, 1, 1, 30000);
  readonly orthographic = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 30000);
  /** The camera in use: one of the two above. */
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera = this.perspective;
  readonly controls: OrbitControls;
  /** One group per category id. */
  readonly groups: THREE.Group[];
  /** Extra objects (debug markers). */
  readonly overlay = new THREE.Group();
  /** Size of the framed area in metres. */
  radius = 1000;
  width = 1;
  height = 1;

  /** Materials by [colored ? 1 : 0][flat shaded ? 1 : 0][category]. */
  private readonly materials: THREE.MeshStandardMaterial[][][];
  private readonly textured = new Map<string, THREE.MeshStandardMaterial>();
  private readonly looks: CategoryLook[];
  private readonly uniforms: Uniforms = {
    heights: { value: new THREE.Vector2(0, 100) },
    contours: { value: 1 },
    grade: { value: new THREE.Vector4() },
    plan: { value: 0 },
    cut: { value: NO_CUT },
    floor: { value: -NO_CUT },
    ground: { value: groundTexture(new Float32Array([-1e5]), 1, 1) },
    groundRect: { value: new THREE.Vector3(0, 0, 1) },
    building: { value: buildingTexture(new Uint8Array([255]), 1, 1) },
    palette: { value: PALETTE_KEYS.map(() => new THREE.Vector3()) },
    texels: { value: 1 },
  };
  /** The plan style is not lit: without lights its shaders skip the lighting altogether. */
  private readonly lights: THREE.Light[];
  /** The plan style's outlines: the map is rendered into `target`, `outline` draws it to the screen. */
  private target: THREE.WebGLRenderTarget | null = null;
  private readonly outline: THREE.ShaderMaterial;
  private readonly copy: THREE.ShaderMaterial;
  private readonly quad: THREE.Mesh;
  private readonly outlineScene = new THREE.Scene();
  private readonly outlineCamera = new THREE.Camera();

  // ---- Tiles ----------------------------------------------------------------------------------
  // A flat view (orthographic, straight down) is drawn from tiles whenever every tile in view is
  // painted, and directly otherwise: so a frame never waits for tiles, and nothing is painted
  // that would be thrown away (while zooming, while a colour is being dragged, in a fast pan).
  // Tiles are painted a few per frame: by `render` when only a few are missing, otherwise by
  // `paintTiles`, which Map3D calls on animation frames while `tilesPending`.
  /** Off: every frame is drawn directly (measurements, comparisons). */
  tileCache = true;
  /** The last frame came from tiles. */
  fromTiles = false;
  private tiles: TileCache | null = null;
  /** The view of the last frame if it was flat. */
  private flat: FlatView | null = null;
  /** Counts changes to what the map looks like: tiles painted before are stale. */
  private content = 0;
  /** No tile is painted before this time. */
  private hold = 0;
  private lastDirect = 0;
  /** What a tile's scene is rendered into before it is finished into the tile; one per style. */
  private tileScene: { plan: boolean; target: THREE.WebGLRenderTarget } | null = null;
  private extent: Bounds = { min: [-Infinity, 0, -Infinity], max: [Infinity, 0, Infinity] };
  private wireframe = false;

  private disposed = false;
  private home = { position: new THREE.Vector3(0, 1000, 1), target: new THREE.Vector3() };

  constructor(
    container: HTMLElement,
    readonly categories: string[],
    background: number,
    /** A draped image arrived: the map needs another frame. */
    private readonly onAssetLoaded: () => void,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.setGrade(COLOR_SCHEMES.standard);
    container.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(background);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = false; // damping needs frames while nothing else changes
    this.controls.screenSpacePanning = false; // pan along the ground
    this.controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
    this.controls.maxPolarAngle = Math.PI * 0.45;
    this.controls.minDistance = MIN_SPAN / 2 / HALF_FOV_TAN;
    this.controls.zoomSpeed = 1.6;
    this.setControlScheme("map");

    const sky = new THREE.HemisphereLight(0xf4f7fb, 0x3a4650, 1.55);
    const key = new THREE.DirectionalLight(0xfff3df, 2.25);
    key.position.set(0.75, 1.4, 0.55).multiplyScalar(1000);
    const fill = new THREE.DirectionalLight(0xbcd2e8, 0.65);
    fill.position.set(-0.8, 0.6, -0.7).multiplyScalar(1000);
    this.lights = [sky, key, fill];
    this.scene.add(...this.lights);

    this.looks = categories.map((name) => LOOKS[name] ?? FALLBACK_LOOK);
    const material = (look: CategoryLook, colored: boolean, flatShading: boolean) =>
      new THREE.MeshStandardMaterial({
        // Material colours (per instance or per vertex) multiply a white base.
        color: colored ? 0xffffff : look.color,
        roughness: look.roughness,
        metalness: 0,
        transparent: look.opacity !== undefined,
        opacity: look.opacity ?? 1,
        flatShading,
      });
    this.materials = [false, true].map((colored) =>
      [false, true].map((flat) => this.looks.map((look) => material(look, colored, flat))),
    );
    const terrain = categories.indexOf("terrain");
    const foliage = categories.indexOf("foliage");
    this.materials.forEach((byShading, colored) => {
      for (const byCategory of byShading) {
        byCategory.forEach((m, category) =>
          customize(m, this.uniforms, {
            grade: colored === 1,
            relief: category === terrain,
            plan: colored === 1 ? PLAN_KINDS[categories[category]!] : undefined,
          }),
        );
        // Roads lie a few centimetres above the terrain, which is coarser than in the game.
        const road = byCategory[categories.indexOf("road")];
        if (road) Object.assign(road, { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8 });
        // Translucent markers must not hide each other or what is behind them.
        const trees = byCategory[foliage];
        if (trees) trees.depthWrite = false;
      }
    });
    this.groups = categories.map((name) => {
      const group = new THREE.Group();
      group.name = name;
      this.scene.add(group);
      return group;
    });
    this.scene.add(this.overlay);

    this.outline = new THREE.ShaderMaterial({
      uniforms: {
        tColor: { value: null },
        tDepth: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uClip: { value: new THREE.Vector3() },
        uPixel: { value: 1 },
        uBackground: { value: new THREE.Color(background) },
        uLine: { value: new THREE.Color() },
      },
      vertexShader: OUTLINE_VERTEX,
      fragmentShader: OUTLINE_FRAGMENT,
      depthTest: false,
      depthWrite: false,
    });
    this.copy = new THREE.ShaderMaterial({
      uniforms: { tColor: { value: null } },
      vertexShader: OUTLINE_VERTEX,
      fragmentShader: COPY_FRAGMENT,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.outline);
    this.quad.frustumCulled = false;
    this.outlineScene.add(this.quad);
    this.setPalette(PLAN_PALETTES.paper);
  }

  /** What the map looks like changed in a way this class cannot see (what is drawn, what is hidden). */
  invalidate(): void {
    this.content++;
  }

  /** The area (x and z) outside of which there is no map. */
  setExtent(bounds: Bounds): void {
    this.extent = bounds;
    this.tiles?.dispose();
    this.tiles = null;
  }

  material(category: number, colored: boolean, flat: boolean): THREE.MeshStandardMaterial {
    return this.materials[colored ? 1 : 0]![flat ? 1 : 0]![category]!;
  }

  /** Category colour, used for slots without a known colour. */
  categoryColor(category: number): number {
    return (this.looks[category] ?? FALLBACK_LOOK).color;
  }

  /** Whether the coloured materials take their colour from a vertex attribute. */
  setVertexColors(on: boolean): void {
    for (const m of this.materials[1]!.flat()) {
      m.vertexColors = on;
      m.needsUpdate = true;
    }
    this.content++;
  }

  /** Material for a mesh with a draped colour image (terrain ground colour), graded like every other colour. */
  texturedMaterial(category: number, url: string): THREE.MeshStandardMaterial {
    let material = this.textured.get(url);
    if (!material) {
      material = this.material(category, true, false).clone();
      const name = this.categories[category]!;
      customize(material, this.uniforms, { grade: true, ground: true, relief: name === "terrain", plan: PLAN_KINDS[name] });
      material.wireframe = this.material(0, false, false).wireframe;
      this.textured.set(url, material);
      const target = material;
      new THREE.TextureLoader().load(url, (texture) => {
        if (this.disposed) return texture.dispose();
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.flipY = false;
        texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
        target.map = texture;
        target.needsUpdate = true;
        this.content++;
        this.onAssetLoaded();
      });
    }
    return material;
  }

  setTerrainHeights(min: number, max: number): void {
    this.uniforms.heights.value.set(min, max);
    this.content++;
  }

  setContours(on: boolean): void {
    this.uniforms.contours.value = on ? 1 : 0;
    this.content++;
  }

  /** The ground heights the plan style measures structure against; null: everything counts as tall. */
  setGround(ground: GroundMap | null): void {
    this.uniforms.ground.value.dispose();
    this.uniforms.ground.value = ground
      ? groundTexture(ground.heights, ground.columns, ground.rows)
      : groundTexture(new Float32Array([-1e5]), 1, 1);
    this.uniforms.groundRect.value.set(ground?.origin[0] ?? 0, ground?.origin[1] ?? 0, 1 / (ground?.cell ?? 1));
    this.uniforms.building.value.dispose();
    this.uniforms.building.value = ground
      ? buildingTexture(ground.building, ground.columns, ground.rows)
      : buildingTexture(new Uint8Array([255]), 1, 1);
    this.content++;
  }

  /**
   * Cuts the map open to look at a floor (a height, where someone's feet are): nothing above
   * head height over it is drawn, and the plan style measures heights from it. null: the whole map.
   */
  setFloor(floor: number | null): void {
    this.uniforms.cut.value = floor === null ? NO_CUT : floor + CUT_ABOVE_FLOOR;
    this.uniforms.floor.value = floor === null ? -NO_CUT : floor;
    this.content++;
  }

  /** The height above which nothing is drawn; Infinity without a cut. */
  get cut(): number {
    return this.uniforms.cut.value === NO_CUT ? Infinity : this.uniforms.cut.value;
  }

  /** Plan style: flat colours by kind and height, with outlines. Otherwise the material colours. */
  setPlan(on: boolean): void {
    this.uniforms.plan.value = on ? 1 : 0;
    for (const light of this.lights) light.visible = !on;
    this.content++;
  }

  setPalette(palette: PlanPalette): void {
    PALETTE_KEYS.forEach((key, i) => {
      const c = Number.parseInt(palette[key].slice(1), 16);
      this.uniforms.palette.value[i]!.set((c >> 16) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255);
    });
    this.outline.uniforms.uLine!.value.set(palette.outline);
    this.content++;
  }

  setWireframe(on: boolean): void {
    for (const m of [...this.materials.flat(2), ...this.textured.values()]) m.wireframe = on;
    this.wireframe = on;
    this.content++;
  }

  setGrade(grade: ColorGrade): void {
    this.renderer.toneMappingExposure = grade.exposure;
    this.uniforms.grade.value.set(grade.lift, grade.contrast, grade.saturation, grade.groundSaturation);
    this.content++;
  }

  /**
   * "map": drag moves the map, right-drag tilts and turns it. "wasd": the keys move (see `move`),
   * so drag tilts and turns and right-drag moves the map. Touch is the same in both.
   */
  setControlScheme(scheme: "map" | "wasd"): void {
    const [left, right] = scheme === "map" ? [THREE.MOUSE.PAN, THREE.MOUSE.ROTATE] : [THREE.MOUSE.ROTATE, THREE.MOUSE.PAN];
    this.controls.mouseButtons = { LEFT: left, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: right };
  }

  setSize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(this.width, this.height, false);
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.target?.setSize(size.x, size.y);
    this.updateFrustums();
  }

  /** The orthographic camera shows `radius` metres across the height of the view at zoom 1. */
  private updateFrustums(): void {
    const aspect = this.width / this.height;
    this.perspective.aspect = aspect;
    this.perspective.updateProjectionMatrix();
    const half = this.radius / 2;
    this.orthographic.left = -half * aspect;
    this.orthographic.right = half * aspect;
    this.orthographic.top = half;
    this.orthographic.bottom = -half;
    this.orthographic.updateProjectionMatrix();
  }

  /** Camera distance at which the perspective view shows the whole map; the orthographic camera stays there. */
  private get homeDistance(): number {
    return this.radius / 2 / HALF_FOV_TAN;
  }

  /** Top-down, north up (north is -z here: Unity's +z), framing the given bounds. */
  frame(bounds: Bounds): void {
    const center = new THREE.Vector3(
      (bounds.min[0] + bounds.max[0]) / 2,
      (bounds.min[1] + bounds.max[1]) / 2,
      (bounds.min[2] + bounds.max[2]) / 2,
    );
    this.radius = Math.max(bounds.max[0] - bounds.min[0], bounds.max[2] - bounds.min[2], 100);
    const distance = this.homeDistance;
    // A hair off vertical: straight down has no "up", and this offset puts north at the top.
    this.home = { position: new THREE.Vector3(center.x, center.y + distance, center.z + distance * 1e-4), target: center };
    this.controls.maxDistance = distance * MAX_SPAN_FACTOR;
    this.controls.minZoom = 1 / MAX_SPAN_FACTOR;
    this.controls.maxZoom = this.radius / MIN_SPAN;
    this.updateFrustums();
    this.resetView();
  }

  resetView(): void {
    this.camera.position.copy(this.home.position);
    this.controls.target.copy(this.home.target);
    this.orthographic.zoom = 1;
    this.orthographic.updateProjectionMatrix();
    this.controls.update();
  }

  /** Metres of ground across the height of the view (at the camera target): the zoom, for either camera. */
  span(): number {
    if (this.camera === this.orthographic) return this.radius / this.orthographic.zoom;
    return 2 * this.camera.position.distanceTo(this.controls.target) * Math.tan(THREE.MathUtils.degToRad(this.perspective.fov / 2));
  }

  setSpan(metres: number): void {
    const span = THREE.MathUtils.clamp(metres, MIN_SPAN, this.radius * MAX_SPAN_FACTOR);
    const offset = this.camera.position.clone().sub(this.controls.target);
    if (this.camera === this.orthographic) {
      // Distance does not zoom a parallel projection; far enough that nothing is behind the camera.
      offset.setLength(this.homeDistance);
      this.orthographic.zoom = this.radius / span;
      this.orthographic.updateProjectionMatrix();
    } else {
      offset.setLength(span / 2 / Math.tan(THREE.MathUtils.degToRad(this.perspective.fov / 2)));
    }
    this.camera.position.copy(this.controls.target).add(offset);
    this.controls.update();
  }

  /** Switches the projection, keeping what is in view: target, direction and zoom. */
  setOrthographic(on: boolean): void {
    const next = on ? this.orthographic : this.perspective;
    if (next === this.camera) return;
    const span = this.span();
    next.position.copy(this.camera.position);
    this.camera = next;
    this.controls.object = next;
    this.setSpan(span);
  }

  /** Direction the top of the screen points to, in radians clockwise from north. */
  heading(): number {
    return -this.controls.getAzimuthalAngle();
  }

  /** Turns the camera around its target, keeping tilt and zoom. */
  setHeading(radians: number): void {
    const offset = this.camera.position.clone().sub(this.controls.target);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    spherical.theta = -radians;
    spherical.makeSafe();
    this.camera.position.copy(this.controls.target).add(offset.setFromSpherical(spherical));
    this.controls.update();
  }

  /** Moves camera and target along the ground, in metres relative to the screen (right, up). */
  move(right: number, forward: number): void {
    this.camera.updateMatrixWorld();
    const m = this.camera.matrixWorld.elements;
    const r = new THREE.Vector3(m[0], 0, m[2]).normalize();
    // The screen's up direction on the ground; looking level it has none, the view direction does.
    const f = new THREE.Vector3(m[4], 0, m[6]);
    if (f.lengthSq() < 1e-6) f.set(-m[8]!, 0, -m[10]!);
    f.normalize();
    const delta = r.multiplyScalar(right).addScaledVector(f, forward);
    this.camera.position.add(delta);
    this.controls.target.add(delta);
    this.controls.update();
  }

  /**
   * Depth precision goes to whatever lies just beyond the near plane, so in perspective both
   * clip planes follow the zoom. Otherwise surfaces a few centimetres apart flicker when seen
   * from far away. A parallel projection spreads precision evenly: fixed planes.
   */
  updateClipPlanes(): void {
    const distance = this.camera.position.distanceTo(this.controls.target);
    const ortho = this.camera === this.orthographic;
    const near = ortho ? 1 : Math.max(0.3, distance * 0.05);
    const far = distance * 3 + this.radius * 3;
    if (Math.abs(near - this.camera.near) > this.camera.near * 0.05 || Math.abs(far - this.camera.far) > this.camera.far * 0.05) {
      this.camera.near = near;
      this.camera.far = far;
      this.camera.updateProjectionMatrix();
    }
  }

  /** The view as tiles see it, or null if it is not one tiles can show. */
  private flatView(): FlatView | null {
    const camera = this.orthographic;
    // A wireframe is lines one texel wide: not something to paint larger and filter down.
    if (!this.tileCache || this.camera !== camera || this.wireframe || this.controls.getPolarAngle() > FLAT_TILT) return null;
    camera.updateMatrixWorld();
    const m = camera.matrixWorld.elements;
    const right = Math.hypot(m[0]!, m[2]!), up = Math.hypot(m[4]!, m[6]!);
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const t = this.controls.target;
    return {
      x: t.x,
      y: t.y,
      z: t.z,
      right: [m[0]! / right, m[2]! / right],
      up: [m[4]! / up, m[6]! / up],
      pixel: (camera.top - camera.bottom) / camera.zoom / size.y,
      width: size.x,
      height: size.y,
      eye: camera.position.y,
      near: camera.near,
      far: camera.far,
    };
  }

  render(): void {
    this.updateClipPlanes();
    const view = this.flatView();
    const before = this.flat;
    this.flat = view;
    this.fromTiles = false;
    if (!view) {
      this.tiles?.clear();
      this.renderDirect(null);
      return;
    }
    const now = performance.now();
    const tiles = (this.tiles ??= new TileCache(this.paint, this.scene.background as THREE.Color, this.extent));
    if (!tiles.look(view, this.content)) this.hold = now + SETTLE;
    if (before && Math.hypot(view.x - before.x, view.z - before.z) > FAST * view.pixel) this.hold = Math.max(this.hold, now + CALM);
    // A tile or two short (the view turned, or moved faster than tiles were painted ahead).
    if (now >= this.hold && tiles.missingInView <= PAINT_NOW) tiles.paint(tiles.missingInView);
    if (!tiles.ready) {
      this.renderDirect(snapShift(view));
      return;
    }
    tiles.draw(this.renderer, this.camera);
    this.fromTiles = true;
    if (this.target && now - this.lastDirect > IDLE_TARGET) {
      this.target.depthTexture?.dispose();
      this.target.dispose();
      this.target = null;
    }
  }

  /** Tiles that the last frame's view needs are not painted yet: `paintTiles` has work to do. */
  get tilesPending(): boolean {
    return this.flat !== null && this.tiles !== null && this.tiles.pending > 0;
  }

  /**
   * Paints a few of the tiles the last frame's view needs. Returns true when that completed the
   * view and the frame on screen was drawn directly: another frame shows it from the tiles.
   */
  paintTiles(): boolean {
    const tiles = this.tiles;
    if (!tiles || !this.flat || performance.now() < this.hold) return false;
    const incomplete = !tiles.ready;
    tiles.paint(PAINT_AHEAD);
    return incomplete && tiles.ready && !this.fromTiles;
  }

  /** One tile: the scene from the tile's camera, then finished as a frame on screen would be. */
  private readonly paint: Painter = (camera, into, scale, pixel) => {
    const plan = this.uniforms.plan.value === 1;
    if (this.tileScene && this.tileScene.plan !== plan) {
      this.tileScene.target.depthTexture?.dispose();
      this.tileScene.target.dispose();
      this.tileScene = null;
    }
    if (!this.tileScene) {
      let target: THREE.WebGLRenderTarget;
      if (plan) {
        target = this.sceneTarget(into.width, into.height);
      } else {
        // Rendered as the screen is: tone mapped, sRGB values, blended and resolved as such. That
        // is what three.js does for a target marked like this. The values are stored as they are
        // (RGBA8, in the multisampled buffer as well: the two have to match to be resolved).
        target = new THREE.WebGLRenderTarget(into.width, into.height, { samples: 4, colorSpace: THREE.SRGBColorSpace, internalFormat: "RGBA8" });
        (target as THREE.WebGLRenderTarget & { isXRRenderTarget: boolean }).isXRRenderTarget = true;
      }
      this.tileScene = { plan, target };
    }
    const { target } = this.tileScene;
    this.uniforms.texels.value = scale;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, camera);
    this.uniforms.texels.value = 1;
    if (plan) {
      this.finish(target, into, camera, pixel, scale);
    } else {
      this.copy.uniforms.tColor!.value = target.texture;
      this.quad.material = this.copy;
      this.renderer.setRenderTarget(into);
      this.renderer.render(this.outlineScene, this.outlineCamera);
      this.renderer.setRenderTarget(null);
    }
  };

  /** What the plan style's scene is rendered into: linear colours and the depth the outlines are found in. */
  private sceneTarget(width: number, height: number): THREE.WebGLRenderTarget {
    // Half floats: linear colours in 8 bits would band in the dark palettes.
    return new THREE.WebGLRenderTarget(width, height, {
      type: THREE.HalfFloatType,
      samples: 4,
      depthTexture: new THREE.DepthTexture(width, height, THREE.UnsignedIntType),
    });
  }

  /**
   * The plan style's second pass: `source` with outlines, onto the screen (null) or into a tile.
   * `pixel`: metres across a device pixel (at depth 1 in perspective); `texels`: texels of
   * `source` across a device pixel.
   */
  private finish(
    source: THREE.WebGLRenderTarget,
    into: THREE.WebGLRenderTarget | null,
    camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
    pixel: number,
    texels: number,
  ): void {
    const u = this.outline.uniforms;
    u.tColor!.value = source.texture;
    u.tDepth!.value = source.depthTexture;
    u.uTexel!.value.set(texels / source.width, texels / source.height);
    u.uClip!.value.set(camera.near, camera.far, camera === this.perspective ? 0 : 1);
    u.uPixel!.value = pixel;
    this.quad.material = this.outline;
    this.renderer.setRenderTarget(into);
    this.renderer.render(this.outlineScene, this.outlineCamera);
    this.renderer.setRenderTarget(null);
  }

  /**
   * The whole scene, as it is. `shift` (metres along x and z) moves the picture: a flat view is
   * put on the pixel grid the tiles are on, so that it does not jump when tiles take over.
   */
  private renderDirect(shift: [number, number] | null): void {
    const camera = this.camera;
    const { x, z } = camera.position;
    if (shift) camera.position.set(x - shift[0], camera.position.y, z - shift[1]);
    this.lastDirect = performance.now();
    if (this.uniforms.plan.value === 0) {
      this.renderer.render(this.scene, camera);
    } else {
      const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
      this.target ??= this.sceneTarget(size.x, size.y);
      this.renderer.setRenderTarget(this.target);
      this.renderer.render(this.scene, camera);
      const parallel = camera === this.orthographic;
      const pixel = (parallel ? this.radius / this.orthographic.zoom : 2 * Math.tan(THREE.MathUtils.degToRad(this.perspective.fov / 2))) / size.y;
      // The statistics are the map's, not the outline pass's.
      const { calls, triangles } = this.renderer.info.render;
      this.finish(this.target, null, camera, pixel, 1);
      this.renderer.info.render.calls = calls;
      this.renderer.info.render.triangles = triangles;
    }
    if (shift) {
      camera.position.set(x, camera.position.y, z);
      camera.updateMatrixWorld();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.controls.dispose();
    for (const m of [...this.materials.flat(2), ...this.textured.values()]) {
      m.map?.dispose();
      m.dispose();
    }
    this.uniforms.ground.value.dispose();
    this.uniforms.building.value.dispose();
    this.target?.depthTexture?.dispose();
    this.target?.dispose();
    this.tiles?.dispose();
    this.tileScene?.target.depthTexture?.dispose();
    this.tileScene?.target.dispose();
    this.outline.dispose();
    this.copy.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
