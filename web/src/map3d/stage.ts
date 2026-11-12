// Renderer, camera, controls and the per-category materials of the 3D map. Nothing here renders
// on its own: Map3D asks for a frame when something changed.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { desaturate, liftColor } from "./color";
import type { Bounds } from "./dataset";

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
};
const FALLBACK_LOOK: CategoryLook = { color: 0xb9c1c8, roughness: 0.93 };

/**
 * Lifted grass means come out lime green; ground images are muted by this much. Keep equal to
 * GROUND_DESATURATION in tools/maps3d/t3d/hlod.py (backdrop terrain).
 */
const GROUND_DESATURATION = 0.4;

/** Contour interval of the terrain in metres (every fifth line is stronger). */
const CONTOUR_INTERVAL = 2;

/** Narrow, so buildings barely lean over the streets in the top-down view. */
const FIELD_OF_VIEW = 25;

interface ReliefUniforms {
  heights: { value: THREE.Vector2 };
  contours: { value: number };
}

/**
 * Terrain relief: darker steep slopes, a tint from low (cooler, darker) to high (warmer, lighter)
 * ground, and contour lines.
 */
function addRelief(material: THREE.MeshStandardMaterial, uniforms: ReliefUniforms, key: string): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uHeights = uniforms.heights;
    shader.uniforms.uContours = uniforms.contours;
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
      .replace(
        "#include <common>",
        "#include <common>\nvarying float vHeight;\nvarying float vUp;\nuniform vec2 uHeights;\nuniform float uContours;",
      )
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
        // No lines on nearly level ground (height noise would speckle it), and lines fade out
        // once they are closer together than a few pixels.
        float sloped = smoothstep(0.0004, 0.003, 1.0 - vUp);
        minor *= sloped * (1.0 - smoothstep(0.15, 0.4, wMinor));
        major *= sloped * (1.0 - smoothstep(0.15, 0.4, wMajor));
        diffuseColor.rgb *= 1.0 - uContours * (0.16 * minor + 0.22 * major);`,
      );
  };
  material.customProgramCacheKey = () => key;
}

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(FIELD_OF_VIEW, 1, 1, 30000);
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
  private readonly relief: ReliefUniforms = { heights: { value: new THREE.Vector2(0, 100) }, contours: { value: 1 } };
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
    this.renderer.toneMappingExposure = 1.05;
    container.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(background);

    // A map: drag moves it, the wheel zooms, right-drag (or two fingers) tilts and turns it.
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = false; // damping needs frames while nothing else changes
    this.controls.screenSpacePanning = false; // pan along the ground
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
    this.controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
    this.controls.maxPolarAngle = Math.PI * 0.45;
    this.controls.minDistance = 15;
    this.controls.zoomSpeed = 1.6;

    this.scene.add(new THREE.HemisphereLight(0xf4f7fb, 0x3a4650, 1.55));
    const key = new THREE.DirectionalLight(0xfff3df, 2.25);
    key.position.set(0.75, 1.4, 0.55).multiplyScalar(1000);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xbcd2e8, 0.65);
    fill.position.set(-0.8, 0.6, -0.7).multiplyScalar(1000);
    this.scene.add(fill);

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
    for (const byCategory of this.materials.flat()) {
      const ground = byCategory[terrain];
      if (ground) addRelief(ground, this.relief, "terrain-relief");
      // Translucent markers must not hide each other or what is behind them.
      const trees = byCategory[foliage];
      if (trees) trees.depthWrite = false;
    }
    this.groups = categories.map((name) => {
      const group = new THREE.Group();
      group.name = name;
      this.scene.add(group);
      return group;
    });
    this.scene.add(this.overlay);
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
  }

  /** Material for a mesh with a draped colour image (terrain ground colour), lifted like every other colour. */
  texturedMaterial(category: number, url: string): THREE.MeshStandardMaterial {
    let material = this.textured.get(url);
    if (!material) {
      material = this.material(category, true, false).clone();
      if (this.categories[category] === "terrain") addRelief(material, this.relief, "terrain-relief-map");
      material.wireframe = this.material(0, false, false).wireframe;
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
        this.onAssetLoaded();
      };
      image.src = url;
    }
    return material;
  }

  setTerrainHeights(min: number, max: number): void {
    this.relief.heights.value.set(min, max);
  }

  setContours(on: boolean): void {
    this.relief.contours.value = on ? 1 : 0;
  }

  setWireframe(on: boolean): void {
    for (const m of [...this.materials.flat(2), ...this.textured.values()]) m.wireframe = on;
  }

  setSize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(this.width, this.height, false);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
  }

  /** Top-down, north up (north is -z here: Unity's +z), framing the given bounds. */
  frame(bounds: Bounds): void {
    const center = new THREE.Vector3(
      (bounds.min[0] + bounds.max[0]) / 2,
      (bounds.min[1] + bounds.max[1]) / 2,
      (bounds.min[2] + bounds.max[2]) / 2,
    );
    this.radius = Math.max(bounds.max[0] - bounds.min[0], bounds.max[2] - bounds.min[2], 100);
    const distance = (this.radius * 0.5) / Math.tan(THREE.MathUtils.degToRad(FIELD_OF_VIEW / 2));
    // A hair off vertical: straight down has no "up", and this offset puts north at the top.
    this.home = { position: new THREE.Vector3(center.x, center.y + distance, center.z + distance * 1e-4), target: center };
    this.controls.maxDistance = distance * 2.5;
    this.resetView();
  }

  resetView(): void {
    this.camera.position.copy(this.home.position);
    this.controls.target.copy(this.home.target);
    this.controls.update();
  }

  /**
   * Depth precision goes to whatever lies just beyond the near plane, so both clip planes follow
   * the zoom. Otherwise surfaces a few centimetres apart flicker when seen from far away.
   */
  updateClipPlanes(): void {
    const distance = this.camera.position.distanceTo(this.controls.target);
    const near = Math.max(0.3, distance * 0.05);
    const far = distance * 3 + this.radius * 3;
    if (Math.abs(near - this.camera.near) > this.camera.near * 0.05 || Math.abs(far - this.camera.far) > this.camera.far * 0.05) {
      this.camera.near = near;
      this.camera.far = far;
      this.camera.updateProjectionMatrix();
    }
  }

  render(): void {
    this.updateClipPlanes();
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.controls.dispose();
    for (const m of [...this.materials.flat(2), ...this.textured.values()]) {
      m.map?.dispose();
      m.dispose();
    }
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
