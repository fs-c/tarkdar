// Renderer, camera, lights, per-category materials and groups.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
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

  constructor(
    container: HTMLElement,
    readonly categories: string[],
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

  /** Category colour, used for slots without a known colour. */
  categoryColor(category: number): number {
    return this.looks[category].color;
  }

  group(name: string): THREE.Group | undefined {
    return this.groups[this.categories.indexOf(name)];
  }

  setWireframe(on: boolean): void {
    for (const m of this.materials.flat(2)) m.wireframe = on;
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
    this.camera.near = Math.max(0.5, radius / 5000);
    this.camera.far = radius * 22;
    this.camera.updateProjectionMatrix();
    this.fog.near = radius * 0.7;
    this.fog.far = radius * 3.2;
    this.lookFrom("home");
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
      this.renderer.render(this.scene, this.camera);
    });
  }
}
