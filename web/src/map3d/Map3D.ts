// The 3D map as the radar uses it: loads a dataset, owns the camera, and renders only when
// something changed (the camera moved, a setting changed, an image arrived). Markers are not
// drawn here: the caller projects world positions through `projector()` onto its own canvas.
//
// Coordinates: the public API speaks the game's world coordinates ([x east, y up, z north],
// as in protocol.ts). Internally z is negated (three.js is right-handed).

import * as THREE from "three";
import { loadMapData, type MapData } from "./dataset";
import { InstanceRenderer } from "./instances";
import { DEFAULT_MAP_SETTINGS, type MapSettings } from "./settings";
import { Stage } from "./stage";

export type WorldPos = [number, number, number];

export interface MapStats {
  drawCalls: number;
  triangles: number;
  /** CPU time of the last frame's submission in ms (not the GPU's time). */
  frameMs: number;
  frames: number;
}

/** What `Projector` in the app needs; kept structural so this module has no app imports. */
export interface MapProjection {
  width: number;
  height: number;
  toScreen(pos: WorldPos): [number, number];
  pxPerMetre(pos: WorldPos): number;
  detail: number;
}

/** Screen pixels per metre that count as the 2D view's zoom 1 (label thresholds, see Projector). */
const DETAIL_PX_PER_METRE = 4;
/** Categories that only make sense with textures; never drawn. */
const HIDDEN = ["shadow", "decal", "background"];

export class Map3D {
  readonly stats: MapStats = { drawCalls: 0, triangles: 0, frameMs: 0, frames: 0 };
  /** Called after every rendered frame (the camera may have moved: redraw the markers). */
  onRender: (() => void) | null = null;
  /** The user moved the map by hand (so a caller that follows something can stop). */
  onUserPan: (() => void) | null = null;

  private stage: Stage | null = null;
  private data: MapData | null = null;
  private instances: InstanceRenderer | null = null;
  private settings: MapSettings = DEFAULT_MAP_SETTINGS;
  private frameRequested = 0;
  private abort: AbortController | null = null;
  private readonly observer: ResizeObserver;
  /** Where the camera target was put by code; a different target means the user panned. */
  private readonly expectedTarget = new THREE.Vector3();
  private readonly scratch = new THREE.Vector3();
  private readonly scratch2 = new THREE.Vector3();

  constructor(
    private readonly container: HTMLElement,
    private readonly background: number,
  ) {
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
  }

  get loaded(): boolean {
    return this.data !== null;
  }

  /** Loads a dataset folder (e.g. /maps/3d/customs), replacing the current map. */
  async load(base: string, onProgress?: (fraction: number) => void): Promise<void> {
    this.unload();
    const abort = (this.abort = new AbortController());
    const data = await loadMapData(base, onProgress, abort.signal);
    if (abort.signal.aborted) return;

    const stage = new Stage(this.container, data.index.categories, this.background, () => this.requestRender());
    const terrain = data.categoryId("terrain");
    let low = Infinity;
    let high = -Infinity;
    for (let s = 0; s < data.slotCount; s++) {
      if (data.slotCategory[s] !== terrain) continue;
      const b = data.slotInstance[s]! * 6;
      low = Math.min(low, data.instBox[b + 1]!);
      high = Math.max(high, data.instBox[b + 4]!);
    }
    if (low < high) stage.setTerrainHeights(low, high);

    this.stage = stage;
    this.data = data;
    this.instances = new InstanceRenderer(stage, data, base);
    this.resize();
    stage.frame(data.index.focusBounds);
    this.expectedTarget.copy(stage.controls.target);
    // Only now: framing the map above also "changes" the camera, and that is not the user.
    stage.controls.addEventListener("change", () => {
      if (stage.controls.target.distanceToSquared(this.expectedTarget) > 1e-6) {
        this.expectedTarget.copy(stage.controls.target);
        this.onUserPan?.();
      }
      this.requestRender();
    });
    this.rebuild();
    this.applySettings();
  }

  unload(): void {
    this.abort?.abort();
    this.abort = null;
    cancelAnimationFrame(this.frameRequested);
    this.frameRequested = 0;
    this.instances?.dispose();
    this.stage?.dispose();
    this.instances = null;
    this.stage = null;
    this.data = null;
  }

  dispose(): void {
    this.unload();
    this.observer.disconnect();
  }

  setSettings(settings: MapSettings): void {
    const recolor = settings.colored !== this.settings.colored;
    this.settings = settings;
    if (recolor) this.rebuild();
    this.applySettings();
  }

  private rebuild(): void {
    if (!this.data || !this.instances) return;
    const data = this.data;
    const visible = new Set(data.index.categories.map((_, id) => id));
    for (const name of HIDDEN) visible.delete(data.categoryId(name));
    this.instances.rebuild(data.slotsOf(visible), this.settings.colored);
  }

  private applySettings(): void {
    const stage = this.stage;
    if (!stage) return;
    const trees = stage.groups[stage.categories.indexOf("foliage")];
    if (trees) trees.visible = this.settings.trees;
    stage.setContours(this.settings.contours);
    stage.setWireframe(this.settings.wireframe);
    this.requestRender();
  }

  private resize(): void {
    if (!this.stage) return;
    this.stage.setSize(this.container.clientWidth, this.container.clientHeight);
    this.requestRender();
  }

  /** Ask for a frame; several requests before the next animation frame make one. */
  requestRender(): void {
    if (this.frameRequested || !this.stage) return;
    this.frameRequested = requestAnimationFrame(() => {
      this.frameRequested = 0;
      this.renderNow();
    });
  }

  /** Render immediately (the measurement harness; everything else uses requestRender). */
  renderNow(): void {
    const stage = this.stage;
    if (!stage) return;
    const t0 = performance.now();
    stage.render();
    const info = stage.renderer.info.render;
    this.stats.drawCalls = info.calls;
    this.stats.triangles = info.triangles;
    this.stats.frameMs = performance.now() - t0;
    this.stats.frames++;
    this.onRender?.();
  }

  // ---- camera ---------------------------------------------------------------------------------

  /** Moves the view so that `pos` is at its centre, keeping zoom, tilt and heading. */
  centerOn(pos: WorldPos): void {
    const stage = this.stage;
    if (!stage) return;
    const target = this.scratch.set(pos[0], pos[1], -pos[2]);
    if (target.distanceToSquared(stage.controls.target) < 1e-6) return;
    const delta = this.scratch2.subVectors(target, stage.controls.target);
    stage.camera.position.add(delta);
    stage.controls.target.copy(target);
    this.expectedTarget.copy(target);
    stage.controls.update(); // fires "change": a frame is requested
  }

  /** factor > 1 zooms in. */
  zoomBy(factor: number): void {
    const stage = this.stage;
    if (!stage) return;
    const offset = this.scratch.subVectors(stage.camera.position, stage.controls.target);
    const distance = THREE.MathUtils.clamp(offset.length() / factor, stage.controls.minDistance, stage.controls.maxDistance);
    stage.camera.position.copy(stage.controls.target).add(offset.setLength(distance));
    stage.controls.update();
  }

  /** Zooms so that about `metres` of ground fit across the shorter side of the view. */
  setViewSpan(metres: number): void {
    const stage = this.stage;
    if (!stage) return;
    const offset = this.scratch.subVectors(stage.camera.position, stage.controls.target);
    const distance = (metres * 0.5) / Math.tan(THREE.MathUtils.degToRad(stage.camera.fov / 2));
    const clamped = THREE.MathUtils.clamp(distance, stage.controls.minDistance, stage.controls.maxDistance);
    stage.camera.position.copy(stage.controls.target).add(offset.setLength(clamped));
    stage.controls.update();
  }

  /** Back to the top-down, north-up view of the whole map. */
  resetView(): void {
    if (!this.stage) return;
    this.stage.resetView();
    this.expectedTarget.copy(this.stage.controls.target);
    this.requestRender();
  }

  /** Camera position and target in world coordinates (debug reports). */
  pose(): { position: WorldPos; target: WorldPos } | null {
    const stage = this.stage;
    if (!stage) return null;
    const p = stage.camera.position, t = stage.controls.target;
    return { position: [p.x, p.y, -p.z], target: [t.x, t.y, -t.z] };
  }

  setPose(position: WorldPos, target: WorldPos): void {
    const stage = this.stage;
    if (!stage) return;
    stage.camera.position.set(position[0], position[1], -position[2]);
    stage.controls.target.set(target[0], target[1], -target[2]);
    this.expectedTarget.copy(stage.controls.target);
    stage.controls.update();
    this.requestRender();
  }

  // ---- projection -----------------------------------------------------------------------------

  /** A snapshot of the current camera for drawing markers. Valid until the next frame. */
  projector(): MapProjection {
    const stage = this.stage;
    if (!stage) return { width: 0, height: 0, toScreen: () => [NaN, NaN], pxPerMetre: () => 0, detail: 0 };
    const { camera, width, height } = stage;
    camera.updateMatrixWorld();
    const viewProjection = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const v = new THREE.Vector4();
    const project = (x: number, y: number, z: number): [number, number] => {
      v.set(x, y, z, 1).applyMatrix4(viewProjection);
      if (v.w <= 0) return [NaN, NaN]; // behind the camera
      return [(v.x / v.w + 1) * 0.5 * width, (1 - v.y / v.w) * 0.5 * height];
    };
    const pxPerMetre = (pos: WorldPos): number => {
      const [x0, y0] = project(pos[0], pos[1], -pos[2]);
      const [x1, y1] = project(pos[0] + right.x, pos[1] + right.y, -pos[2] + right.z);
      const d = Math.hypot(x1 - x0, y1 - y0);
      return Number.isFinite(d) ? d : 0;
    };
    const t = stage.controls.target;
    return {
      width,
      height,
      toScreen: (pos) => project(pos[0], pos[1], -pos[2]),
      pxPerMetre,
      detail: pxPerMetre([t.x, t.y, -t.z]) / DETAIL_PX_PER_METRE,
    };
  }

  /** The map surface under a canvas position (CSS pixels): world position and the mesh hit. */
  pick(x: number, y: number): { pos: WorldPos; mesh: string } | null {
    const stage = this.stage;
    if (!stage) return null;
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2((x / stage.width) * 2 - 1, -(y / stage.height) * 2 + 1), stage.camera);
    // Tree markers are see-through reference symbols: pick what is behind them.
    const hit = raycaster.intersectObjects(stage.groups, true).find((h) => h.object.name !== "tree_marker");
    return hit ? { pos: [hit.point.x, hit.point.y, -hit.point.z], mesh: hit.object.name } : null;
  }

  /** Internals for the measurement harness. */
  debug(): { stage: Stage; data: MapData } | null {
    return this.stage && this.data ? { stage: this.stage, data: this.data } : null;
  }
}
