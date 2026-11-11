// Renderer, camera, lights, per-category materials and groups.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { desaturate, liftColor } from "./color";
import type { Bounds } from "./dataset";

interface CategoryLook {
  color: number;
  roughness: number;
  opacity?: number;
}

// No textures yet. A few muted materials separate terrain, vegetation, water
// and built geometry so the shape reads without albedo maps.
const LOOKS: Record<string, CategoryLook> = {
  structure: { color: 0xb9c1c8, roughness: 0.93 },
  terrain: { color: 0x7d8a6f, roughness: 1.0 },
  foliage: { color: 0x5f724d, roughness: 1.0 },
  water: { color: 0x5a7f90, roughness: 0.32, opacity: 0.82 },
  glass: { color: 0x9fc4d8, roughness: 0.2, opacity: 0.4 },
  shadow: { color: 0x3f4a55, roughness: 1.0, opacity: 0.55 },
  decal: { color: 0xd05a9a, roughness: 1.0 },
  background: { color: 0x3f8f9a, roughness: 1.0 },
};
const FALLBACK_LOOK = LOOKS.structure;

// The overview has no interiors: translucent glass would let you look through
// a building, so windows are solid there. Trees are simple markers and are
// drawn translucent so they do not hide what stands behind them.
const OVERVIEW_LOOKS: Record<string, CategoryLook> = {
  glass: { color: 0x7f97a8, roughness: 0.25 },
  foliage: { color: 0x6c8a5e, roughness: 1.0, opacity: 0.6 },
};

/**
 * Lifted grass means come out lime green; ground images are muted by this
 * much. Keep equal to GROUND_DESATURATION in extract/t3d/hlod.py (backdrop terrain).
 */
const GROUND_DESATURATION = 0.4;

/** Contour interval of the terrain in metres (every fifth line is stronger). */
const CONTOUR_INTERVAL = 2;

/**
 * Terrain relief: darker steep slopes, a tint from low (cooler, darker) to
 * high (warmer, lighter) ground, and contour lines.
 */
function addRelief(material: THREE.MeshStandardMaterial, heights: { value: THREE.Vector2 }, key = "terrain-relief"): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uHeights = heights;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying float vHeight;\nvarying float vUp;")
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vHeight = (modelMatrix * instanceMatrix * vec4(position, 1.0)).y;
        #else
          vHeight = (modelMatrix * vec4(position, 1.0)).y;
        #endif
        vUp = normal.y;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vHeight;\nvarying float vUp;\nuniform vec2 uHeights;")
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        float level = clamp((vHeight - uHeights.x) / max(uHeights.y - uHeights.x, 1.0), 0.0, 1.0);
        diffuseColor.rgb *= mix(vec3(0.78, 0.86, 0.84), vec3(1.16, 1.12, 0.98), level);
        diffuseColor.rgb *= mix(0.62, 1.0, smoothstep(0.75, 0.99, vUp));
        float c = vHeight / ${CONTOUR_INTERVAL.toFixed(1)};
        float wMinor = fwidth(c);
        float wMajor = fwidth(c / 5.0);
        float minor = 1.0 - smoothstep(0.0, 1.2, abs(fract(c - 0.5) - 0.5) / wMinor);
        float major = 1.0 - smoothstep(0.0, 1.6, abs(fract(c / 5.0 - 0.5) - 0.5) / wMajor);
        // No lines on nearly level ground (height noise would speckle it), and
        // lines fade out once they are closer together than a few pixels.
        float sloped = smoothstep(0.0004, 0.003, 1.0 - vUp);
        minor *= sloped * (1.0 - smoothstep(0.15, 0.4, wMinor));
        major *= sloped * (1.0 - smoothstep(0.15, 0.4, wMajor));
        diffuseColor.rgb *= 1.0 - 0.16 * minor - 0.22 * major;`,
      );
  };
  material.customProgramCacheKey = () => key;
}

export interface View {
  center: THREE.Vector3;
  radius: number;
  home: THREE.Vector3;
  top: THREE.Vector3;
}

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  /** One group per category id. */
  readonly groups: THREE.Group[];
  readonly highlights = new THREE.Group();
  view: View | null = null;
  grid: THREE.GridHelper | null = null;

  /** Materials by [colored ? 1 : 0][flat shaded ? 1 : 0][category]. */
  private readonly materials: THREE.MeshStandardMaterial[][][];
  private readonly looks: CategoryLook[];
  private readonly fog: THREE.Fog;
  private readonly terrainHeights = { value: new THREE.Vector2(0, 100) };
  private readonly textured = new Map<string, THREE.MeshStandardMaterial>();

  constructor(
    container: HTMLElement,
    readonly categories: string[],
    /** The dataset is a merged-cell overview (see OVERVIEW_LOOKS). */
    overview = false,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.appendChild(this.renderer.domElement);

    const sky = new THREE.Color(0x9aacbd);
    this.scene.background = sky;
    this.fog = new THREE.Fog(sky, 900, 4200);
    this.scene.fog = this.fog;

    this.camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.5, 30000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.075;
    this.controls.screenSpacePanning = false;
    this.controls.minDistance = 4;
    this.controls.maxDistance = 9000;
    this.controls.maxPolarAngle = Math.PI * 0.495;

    this.scene.add(new THREE.HemisphereLight(0xf4f7fb, 0x3a4650, 1.55));
    const key = new THREE.DirectionalLight(0xfff3df, 2.25);
    key.position.set(0.75, 1.4, 0.55).multiplyScalar(1000);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xbcd2e8, 0.65);
    fill.position.set(-0.8, 0.6, -0.7).multiplyScalar(1000);
    this.scene.add(fill);

    this.looks = categories.map((name) => (overview && OVERVIEW_LOOKS[name]) || LOOKS[name] || FALLBACK_LOOK);
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
    for (const m of this.materials.flat(2)) m.side = THREE.FrontSide;
    for (const byFlat of this.materials.flat()) {
      if (terrain >= 0) addRelief(byFlat[terrain], this.terrainHeights);
      // Translucent markers must not hide each other or what is behind them.
      if (overview && foliage >= 0) byFlat[foliage].depthWrite = false;
    }
    this.groups = categories.map((name) => {
      const group = new THREE.Group();
      group.name = name;
      this.scene.add(group);
      return group;
    });
    this.scene.add(this.highlights);

    window.addEventListener("resize", () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });
  }

  material(category: number, colored: boolean, flat = false): THREE.MeshStandardMaterial {
    return this.materials[colored ? 1 : 0][flat ? 1 : 0][category];
  }

  /** Whether the coloured materials take their colour from a vertex attribute. */
  setVertexColors(on: boolean): void {
    for (const m of this.materials[1].flat()) {
      m.vertexColors = on;
      m.needsUpdate = true;
    }
  }

  /**
   * Material for a mesh with a draped colour image (terrain ground colour).
   * The image is lifted like every other material colour; it appears when it
   * has loaded.
   */
  texturedMaterial(category: number, url: string): THREE.MeshStandardMaterial {
    let material = this.textured.get(url);
    if (!material) {
      material = this.materials[1][0][category].clone();
      if (this.categories[category] === "terrain") addRelief(material, this.terrainHeights, "terrain-relief-map");
      material.wireframe = this.materials[0][0][0].wireframe;
      this.textured.set(url, material);
      const target = material;
      const image = new Image();
      image.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d");
        if (!context) return;
        context.drawImage(image, 0, 0);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
        for (let i = 0; i < pixels.data.length; i += 4) {
          liftColor(pixels.data, i);
          desaturate(pixels.data, GROUND_DESATURATION, i);
        }
        context.putImageData(pixels, 0, 0);
        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.flipY = false;
        texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
        target.map = texture;
        target.needsUpdate = true;
        this.onTextureLoaded?.();
      };
      image.src = url;
    }
    return material;
  }

  /** Called when a draped image has arrived (for viewers that render on demand). */
  onTextureLoaded: (() => void) | null = null;

  /** Height range of the terrain in metres, for the relief tint. */
  setTerrainHeights(min: number, max: number): void {
    this.terrainHeights.value.set(min, max);
  }

  /** Category colour, used for slots without a known colour. */
  categoryColor(category: number): number {
    return this.looks[category].color;
  }

  group(name: string): THREE.Group | undefined {
    return this.groups[this.categories.indexOf(name)];
  }

  setWireframe(on: boolean): void {
    for (const m of [...this.materials.flat(2), ...this.textured.values()]) m.wireframe = on;
  }

  /** 100 m grid under the map; returns the cell size in metres. */
  makeGrid(bounds: Bounds): number {
    if (this.grid) {
      this.scene.remove(this.grid);
      this.grid.geometry.dispose();
      (this.grid.material as THREE.Material).dispose();
    }
    const span = Math.max(bounds.max[0] - bounds.min[0], bounds.max[2] - bounds.min[2]) * 1.7;
    const divisions = Math.max(8, Math.min(160, Math.round(span / 100)));
    const size = divisions * 100;
    this.grid = new THREE.GridHelper(size, divisions, 0x33414d, 0x3c4b57);
    this.grid.position.set((bounds.min[0] + bounds.max[0]) / 2, bounds.min[1] - 2, (bounds.min[2] + bounds.max[2]) / 2);
    const material = this.grid.material as THREE.Material;
    material.transparent = true;
    material.opacity = 0.45;
    this.scene.add(this.grid);
    return size / divisions;
  }

  /** Point the camera at the playable core and tune clip planes and fog to it. */
  frame(bounds: Bounds): void {
    const min = new THREE.Vector3(...bounds.min);
    const max = new THREE.Vector3(...bounds.max);
    const center = new THREE.Vector3().addVectors(min, max).multiplyScalar(0.5);
    const size = new THREE.Vector3().subVectors(max, min);
    const radius = Math.max(size.x, size.y, size.z);
    this.view = {
      center,
      radius,
      home: new THREE.Vector3(center.x + radius * 0.3, center.y + radius * 0.45, center.z + radius * 0.55),
      top: new THREE.Vector3(center.x, center.y + radius * 1.05, center.z + radius * 0.012),
    };
    this.camera.far = radius * 12;
    this.updateNear();
    this.fog.near = radius * 0.7;
    this.fog.far = radius * 3.2;
    this.lookFrom("home");
  }

  /**
   * Depth precision goes to whatever lies just beyond the near plane, so the
   * near plane follows the zoom: far out it is pushed away, which removes the
   * flicker between surfaces that lie a few centimetres apart.
   */
  updateNear(): void {
    const distance = this.camera.position.distanceTo(this.controls.target);
    const near = Math.min(60, Math.max(0.3, distance * 0.02));
    if (Math.abs(near - this.camera.near) > this.camera.near * 0.05) {
      this.camera.near = near;
      this.camera.updateProjectionMatrix();
    }
  }

  lookFrom(which: "home" | "top"): void {
    if (!this.view) return;
    this.camera.position.copy(this.view[which]);
    this.controls.target.copy(this.view.center);
    this.controls.update();
  }

  /** Start rendering; onPerf is called twice a second. */
  start(onPerf: (fps: number, calls: number, triangles: number) => void): void {
    let last = performance.now();
    let frames = 0;
    this.renderer.setAnimationLoop(() => {
      const now = performance.now();
      frames++;
      if (now - last >= 500) {
        const info = this.renderer.info.render;
        onPerf((frames * 1000) / (now - last), info.calls, info.triangles);
        frames = 0;
        last = now;
      }
      this.controls.update();
      this.updateNear();
      this.renderer.render(this.scene, this.camera);
    });
  }
}
