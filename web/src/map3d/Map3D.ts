// The 3D map as the radar uses it: loads a dataset, owns the camera, and renders only when
// something changed (the camera moved, a setting changed, an image arrived). Markers are not
// drawn here: the caller projects world positions through `projector()` onto its own canvas.
//
// Coordinates: the public API speaks the game's world coordinates ([x east, y up, z north],
// as in protocol.ts). Internally z is negated (three.js is right-handed).

import * as THREE from "three";
import { loadMapData, type MapData } from "./dataset";
import { InstanceRenderer } from "./instances";
import { DEFAULT_MAP_SETTINGS, type MapSettings, PLAN_PALETTES } from "./settings";
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
  depth(pos: WorldPos): number;
}

/** Screen pixels per metre that count as the 2D view's zoom 1 (label thresholds, see Projector). */
const DETAIL_PX_PER_METRE = 4;
/** WASD movement: view heights per second, and the factor with Shift held. */
const MOVE_SPEED = 0.7;
const MOVE_FAST = 3;
/** Following a direction: the remaining angle shrinks to 1/e in this many ms. */
const TURN_TIME = 140;
/** Categories that only make sense with textures; never drawn. */
const HIDDEN = ["shadow", "decal", "background"];

/** a - b, in (-pi, pi]. */
function angleDifference(a: number, b: number): number {
  const d = (a - b) % (2 * Math.PI);
  return d > Math.PI ? d - 2 * Math.PI : d <= -Math.PI ? d + 2 * Math.PI : d;
}

export class Map3D {
  readonly stats: MapStats = { drawCalls: 0, triangles: 0, frameMs: 0, frames: 0 };
  /** Called after every rendered frame (the camera may have moved: redraw the markers). */
  onRender: (() => void) | null = null;
  /** The user moved the map by hand (so a caller that follows something can stop). */
  onUserPan: (() => void) | null = null;
  /** The user turned the map by hand (so a caller that follows a direction can stop). */
  onUserTurn: (() => void) | null = null;

  private stage: Stage | null = null;
  private data: MapData | null = null;
  private instances: InstanceRenderer | null = null;
  private settings: MapSettings = DEFAULT_MAP_SETTINGS;
  private frameRequested = 0;
  private readonly motion = { right: 0, forward: 0, fast: false, frame: 0, time: 0 };
  private abort: AbortController | null = null;
  private readonly observer: ResizeObserver;
  /** Where the camera target was put by code; a different target means the user panned. */
  private readonly expectedTarget = new THREE.Vector3();
  /** The heading code left the camera at; a different one means the user turned the map. */
  private expectedHeading = 0;
  private byCode = false;
  private readonly turn = { goal: 0, frame: 0, time: 0 };
  private flight: { frame: number; start: number; duration: number; from: THREE.Vector3; fromSpan: number; span: number | null; to: () => WorldPos | null } | null = null;
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
    stage.setGround(data.ground);

    this.stage = stage;
    this.data = data;
    this.instances = new InstanceRenderer(stage, data, base);
    this.resize();
    stage.frame(data.index.focusBounds);
    this.expectedTarget.copy(stage.controls.target);
    this.expectedHeading = stage.heading();
    // Only now: framing the map above also "changes" the camera, and that is not the user.
    stage.controls.addEventListener("change", () => {
      if (this.byCode) return;
      if (stage.controls.target.distanceToSquared(this.expectedTarget) > 1e-6) {
        this.expectedTarget.copy(stage.controls.target);
        this.cancelFlight();
        this.onUserPan?.();
      }
      if (Math.abs(angleDifference(stage.heading(), this.expectedHeading)) > 1e-4) {
        this.expectedHeading = stage.heading();
        cancelAnimationFrame(this.turn.frame);
        this.turn.frame = 0;
        this.onUserTurn?.();
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
    cancelAnimationFrame(this.motion.frame);
    this.motion.frame = 0;
    this.cancelFlight();
    cancelAnimationFrame(this.turn.frame);
    this.turn.frame = 0;
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
    const colored = (s: MapSettings) => s.colored || s.style === "plan";
    const recolor = colored(settings) !== colored(this.settings);
    this.settings = settings;
    if (recolor) this.rebuild();
    this.applySettings();
  }

  private rebuild(): void {
    if (!this.data || !this.instances) return;
    const data = this.data;
    const visible = new Set(data.index.categories.map((_, id) => id));
    for (const name of HIDDEN) visible.delete(data.categoryId(name));
    // The plan style works from the material colours as well.
    this.instances.rebuild(data.slotsOf(visible), this.settings.colored || this.settings.style === "plan");
  }

  private applySettings(): void {
    const stage = this.stage;
    if (!stage) return;
    const trees = stage.groups[stage.categories.indexOf("foliage")];
    if (trees) trees.visible = this.settings.trees;
    stage.setContours(this.settings.contours);
    stage.setWireframe(this.settings.wireframe);
    stage.setGrade(this.settings);
    stage.setPlan(this.settings.style === "plan");
    // A stored palette may predate a colour added since.
    stage.setPalette({ ...PLAN_PALETTES.paper, ...this.settings.palette });
    stage.setControlScheme(this.settings.controls);
    stage.setOrthographic(this.settings.orthographic);
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

  /** Runs a camera change that is the code's own: not a pan or turn by the user. */
  private own(change: (stage: Stage) => void): void {
    const stage = this.stage;
    if (!stage) return;
    this.byCode = true;
    try {
      change(stage);
    } finally {
      this.byCode = false;
    }
    this.expectedTarget.copy(stage.controls.target);
    this.expectedHeading = stage.heading();
    this.requestRender();
  }

  /** A flight (flyTo) is under way. */
  get flying(): boolean {
    return this.flight !== null;
  }

  /**
   * Flies the view to a position, smoothly. `to` is asked on every frame, so the flight ends on
   * a moving target (the local player). `span`: also zoom to this many metres across the view.
   * Moving the map by hand ends the flight where it is.
   */
  flyTo(to: () => WorldPos | null, span: number | null = null): void {
    const stage = this.stage;
    const goal = to();
    if (!stage || !goal) return;
    this.cancelFlight();
    const from = stage.controls.target.clone();
    const fromSpan = stage.span();
    // Longer for longer ways, measured in views: a hop across the screen, not across the map.
    const views = from.distanceTo(this.scratch.set(goal[0], goal[1], -goal[2])) / Math.max(fromSpan, 1);
    const duration = THREE.MathUtils.clamp(350 + 250 * views, 350, 1200);
    this.flight = { frame: requestAnimationFrame(this.flightStep), start: performance.now(), duration, from, fromSpan, span, to };
  }

  private cancelFlight(): void {
    if (this.flight) cancelAnimationFrame(this.flight.frame);
    this.flight = null;
  }

  private readonly flightStep = (now: number): void => {
    const { flight, stage } = this;
    if (!flight || !stage) return;
    const goal = flight.to();
    const t = goal ? Math.min(1, (now - flight.start) / flight.duration) : 1;
    const eased = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
    if (goal) {
      const target = this.scratch.set(goal[0], goal[1], -goal[2]).lerp(flight.from, 1 - eased);
      stage.camera.position.add(this.scratch2.subVectors(target, stage.controls.target));
      stage.controls.target.copy(target);
      this.expectedTarget.copy(target);
      // Zoom is a ratio: interpolated in the exponent it looks even.
      if (flight.span !== null) stage.setSpan(flight.fromSpan * (flight.span / flight.fromSpan) ** eased);
      else stage.controls.update();
    }
    // The flight may have been cancelled by the update above (it reports a change).
    if (this.flight === flight) flight.frame = t < 1 ? requestAnimationFrame(this.flightStep) : 0;
    if (t >= 1 && this.flight === flight) this.flight = null;
    // This frame, not the next one.
    cancelAnimationFrame(this.frameRequested);
    this.frameRequested = 0;
    this.renderNow();
  };

  /**
   * Turns the view, smoothly, until `degrees` (clockwise from north, a player's yaw) points up.
   * Call it again whenever the direction changes: the view keeps following. Frames are rendered
   * only while it turns.
   */
  turnTo(degrees: number): void {
    this.turn.goal = THREE.MathUtils.degToRad(degrees);
    if (!this.turn.frame && this.stage) {
      this.turn.time = performance.now();
      this.turn.frame = requestAnimationFrame(this.turnStep);
    }
  }

  private readonly turnStep = (now: number): void => {
    const { turn, stage } = this;
    turn.frame = 0;
    if (!stage) return;
    const heading = stage.heading();
    const difference = angleDifference(turn.goal, heading);
    const arrived = Math.abs(difference) < 2e-3;
    // The same share of the remaining angle per unit of time, whatever the frame rate.
    const share = arrived ? 1 : 1 - Math.exp(-Math.max(0, now - turn.time) / TURN_TIME);
    turn.time = now;
    this.own(() => stage.setHeading(heading + difference * share));
    cancelAnimationFrame(this.frameRequested);
    this.frameRequested = 0;
    this.renderNow();
    if (!arrived) turn.frame = requestAnimationFrame(this.turnStep);
  };

  /** factor > 1 zooms in. */
  zoomBy(factor: number): void {
    if (!this.stage) return;
    this.stage.setSpan(this.stage.span() / factor);
    this.requestRender();
  }

  /** Metres of ground across the height of the view. */
  viewSpan(): number {
    return this.stage?.span() ?? 0;
  }

  /** Zooms so that about `metres` of ground fit across the height of the view. */
  setViewSpan(metres: number): void {
    if (!this.stage) return;
    this.stage.setSpan(metres);
    this.requestRender();
  }

  /**
   * Keeps moving the view along the ground (the WASD keys): right and forward are -1, 0 or 1
   * relative to the screen. Frames are rendered only while something is held.
   */
  setMotion(right: number, forward: number, fast: boolean): void {
    Object.assign(this.motion, { right, forward, fast });
    if ((right || forward) && !this.motion.frame && this.stage) {
      this.motion.time = performance.now();
      this.motion.frame = requestAnimationFrame(this.moveStep);
    }
  }

  private readonly moveStep = (now: number): void => {
    const { motion, stage } = this;
    motion.frame = 0;
    const length = Math.hypot(motion.right, motion.forward);
    if (!stage || !length) return;
    const seconds = Math.min(0.1, Math.max(0, now - motion.time) / 1000);
    motion.time = now;
    // Speed follows the zoom: the same share of the view per second at any height.
    const metres = (stage.span() * MOVE_SPEED * (motion.fast ? MOVE_FAST : 1) * seconds) / length;
    stage.move(motion.right * metres, motion.forward * metres); // "change": the user panned
    // This frame, not the next one.
    cancelAnimationFrame(this.frameRequested);
    this.frameRequested = 0;
    this.renderNow();
    motion.frame = requestAnimationFrame(this.moveStep);
  };

  /** Back to the top-down, north-up view of the whole map. */
  resetView(): void {
    this.cancelFlight();
    this.own((stage) => stage.resetView());
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
    this.own(() => {
      stage.camera.position.set(position[0], position[1], -position[2]);
      stage.controls.target.set(target[0], target[1], -target[2]);
      stage.controls.update();
    });
  }

  // ---- projection -----------------------------------------------------------------------------

  /** A snapshot of the current camera for drawing markers. Valid until the next frame. */
  projector(): MapProjection {
    const stage = this.stage;
    if (!stage) return { width: 0, height: 0, toScreen: () => [NaN, NaN], pxPerMetre: () => 0, detail: 0, depth: () => 0 };
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
    const eye = camera.position.clone();
    return {
      width,
      height,
      toScreen: (pos) => project(pos[0], pos[1], -pos[2]),
      pxPerMetre,
      detail: pxPerMetre([t.x, t.y, -t.z]) / DETAIL_PX_PER_METRE,
      depth: (pos) => Math.hypot(pos[0] - eye.x, pos[1] - eye.y, -pos[2] - eye.z),
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
