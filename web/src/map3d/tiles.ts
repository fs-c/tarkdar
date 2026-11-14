// The map as a 2D picture, for the view the radar is used in during a raid: orthographic and
// straight down. In that view moving and turning the camera only moves and turns the picture, so
// the picture is kept: square tiles on a grid fixed to the world, painted once (Stage.paint) and
// then drawn as textured squares. A frame while following a player is a handful of squares
// instead of the whole map.
//
// Tiles are painted larger than they are shown (SCALE texels per device pixel in each direction)
// and filtered down when drawn: that is the antialiasing, for the outlines and colour steps of
// the plan style as well, which multisampling does not reach.
//
// A tile is only good for one zoom (and one content: style, colours, floor): anything else
// starts over. Nothing here decides when to paint; Stage does (stage.ts, "Tiles").

import * as THREE from "three";
import type { Bounds } from "./dataset";

/** Texels along a tile texture. GUTTER on each side belong to the neighbours: the outlines and the filter look that far. */
export const TILE_SIZE = 1024;
const GUTTER = 4;
const INTERIOR = TILE_SIZE - 2 * GUTTER;
/** Tiles are painted before they come into view: this many device pixels outside it. */
const MARGIN = 160;
/** Texels per device pixel when memory allows it, and what the tiles of a view may take (bytes). */
const SCALE = 2;
const MEMORY = 200e6;
/** Turned less than this (radians) off a multiple of 90°, texels and screen pixels line up. */
const ALIGNED = 1e-5;

/** A top-down parallel view, in the renderer's space. */
export interface FlatView {
  /** What is at the centre of the screen. Tiles are drawn at height y. */
  x: number;
  y: number;
  z: number;
  /** The screen's right and up directions on the ground: unit vectors (x, z). */
  right: [number, number];
  up: [number, number];
  /** Metres per device pixel. */
  pixel: number;
  /** Size of the drawing buffer. */
  width: number;
  height: number;
  /** Height of the camera and its clip planes: the tiles are painted from there. */
  eye: number;
  near: number;
  far: number;
}

/**
 * Paints what `camera` sees into `into`, finished (as it would be on screen), at `scale` texels
 * per device pixel; `pixel` is metres per device pixel.
 */
export type Painter = (camera: THREE.OrthographicCamera, into: THREE.WebGLRenderTarget, scale: number, pixel: number) => void;

/** A texture and the square that shows it. */
interface Sheet {
  target: THREE.WebGLRenderTarget;
  mesh: THREE.Mesh;
}

interface Tile {
  /** Null: nothing of the map is there. */
  sheet: Sheet | null;
  /** When a view last needed it (TileCache.clock). */
  used: number;
}

interface Missing {
  i: number;
  j: number;
  visible: boolean;
  distance: number;
}

const COMPOSE_VERTEX = `
uniform vec2 uInset;
varying vec2 vUv;
void main() {
  vUv = uInset.x + uv * uInset.y;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// One bilinear tap per pixel. With two texels per pixel and texels lined up with the screen
// (snapShift) the pixel's centre is the corner of its four texels, and the tap is exactly their
// mean; turned or in between it is a tent as wide as the pixel. (Four taps for a wider filter
// were tried: three times the frame time on an integrated GPU, for no visible difference.)
const COMPOSE_FRAGMENT = `
uniform sampler2D tTile;
varying vec2 vUv;
void main() {
  gl_FragColor = vec4(texture2D(tTile, vUv).rgb, 1.0);
  #include <colorspace_fragment>
}`;

/**
 * Where the picture has to move (metres along x and z, at most half a device pixel) for texels
 * to fall on screen pixels; nothing while the view is turned. The direct rendering uses the same
 * shift, so a frame from tiles and one without show the same pixels.
 */
export function snapShift(view: FlatView): [number, number] {
  const { right, up, pixel } = view;
  if (Math.min(Math.abs(right[0]), Math.abs(right[1])) > ALIGNED) return [0, 0];
  // Screen position of the world's origin, in device pixels.
  const sx = view.width / 2 - (view.x * right[0] + view.z * right[1]) / pixel;
  const sy = view.height / 2 - (view.x * up[0] + view.z * up[1]) / pixel;
  const dx = (Math.round(sx) - sx) * pixel;
  const dy = (Math.round(sy) - sy) * pixel;
  return [right[0] * dx + up[0] * dy, right[1] * dx + up[1] * dy];
}

export class TileCache {
  private readonly tiles = new Map<string, Tile>();
  private readonly spare: Sheet[] = [];
  private readonly camera = new THREE.OrthographicCamera();
  private readonly scene = new THREE.Scene();
  private readonly group = new THREE.Group();
  /** A unit square on the ground; v runs north, as in a tile's texture. */
  private readonly geometry = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  private readonly inset = { value: new THREE.Vector2(GUTTER / TILE_SIZE, INTERIOR / TILE_SIZE) };
  /** What the tiles were painted for: content, zoom, scale. */
  private key = "";
  private view: FlatView | null = null;
  private scale = 1;
  /** Size of a tile on the ground in metres. */
  private size = 1;
  /** Tiles the last view needs and does not have: the ones in view first, nearest first. */
  private missing: Missing[] = [];
  private missingVisible = 0;
  private clock = 0;

  constructor(
    private readonly painter: Painter,
    background: THREE.Color,
    /** Outside of this (x and z) there is no map: such tiles are not painted. */
    private readonly bounds: Bounds,
  ) {
    this.scene.background = background;
    this.scene.add(this.group);
    this.camera.up.set(0, 0, -1); // north at the top of a tile
  }

  /** Texels per device pixel that the tiles of a view this large can afford. */
  private static scaleFor(width: number, height: number): number {
    const across = (pixels: number, scale: number) => Math.ceil(((pixels + 2 * MARGIN) * scale) / INTERIOR) + 1;
    const bytes = across(width, SCALE) * across(height, SCALE) * TILE_SIZE * TILE_SIZE * 4;
    return bytes <= MEMORY ? SCALE : 1;
  }

  /**
   * Takes a view: works out the tiles it needs. `content` identifies what the map looks like;
   * tiles painted for another content or another zoom are dropped. Returns false if that happened.
   */
  look(view: FlatView, content: number): boolean {
    const scale = TileCache.scaleFor(view.width, view.height);
    const key = `${content}/${view.pixel}/${scale}`;
    const kept = key === this.key;
    if (!kept) {
      for (const tile of this.tiles.values()) if (tile.sheet) this.retire(tile.sheet);
      this.tiles.clear();
      this.key = key;
    }
    this.view = view;
    this.scale = scale;
    const size = (this.size = (INTERIOR * view.pixel) / scale);

    // Tiles under the view's rectangle (which may be turned), grown by the margin.
    const halfWidth = (view.width / 2) * view.pixel, halfHeight = (view.height / 2) * view.pixel;
    const margin = MARGIN * view.pixel;
    const { right, up } = view;
    const reachX = Math.abs(right[0]) * (halfWidth + margin) + Math.abs(up[0]) * (halfHeight + margin);
    const reachZ = Math.abs(right[1]) * (halfWidth + margin) + Math.abs(up[1]) * (halfHeight + margin);
    // How far a tile reaches along the screen's axes from its centre.
    const reach = (size / 2) * (Math.abs(right[0]) + Math.abs(right[1]));
    const stamp = ++this.clock;
    this.missing = [];
    this.missingVisible = 0;
    let needed = 0;
    for (let j = Math.floor((view.z - reachZ) / size); j * size < view.z + reachZ; j++) {
      for (let i = Math.floor((view.x - reachX) / size); i * size < view.x + reachX; i++) {
        const dx = (i + 0.5) * size - view.x, dz = (j + 0.5) * size - view.z;
        const along = Math.abs(dx * right[0] + dz * right[1]) - reach;
        const across = Math.abs(dx * up[0] + dz * up[1]) - reach;
        if (along >= halfWidth + margin || across >= halfHeight + margin) continue;
        needed++;
        const id = `${i},${j}`;
        let tile = this.tiles.get(id);
        if (!tile && this.blank(i, j)) this.tiles.set(id, (tile = { sheet: null, used: stamp }));
        if (tile) {
          tile.used = stamp;
          continue;
        }
        const visible = along < halfWidth && across < halfHeight;
        if (visible) this.missingVisible++;
        this.missing.push({ i, j, visible, distance: dx * dx + dz * dz });
      }
    }
    this.missing.sort((a, b) => +b.visible - +a.visible || a.distance - b.distance);
    this.trim(needed + (needed >> 2) + 2);
    return kept;
  }

  /** Nothing of the map lies in this tile. */
  private blank(i: number, j: number): boolean {
    const { min, max } = this.bounds;
    const size = this.size;
    return (i + 1) * size < min[0] || i * size > max[0] || (j + 1) * size < min[2] || j * size > max[2];
  }

  /** Keeps at most `count` textures: the tiles not needed for longest go first. */
  private trim(count: number): void {
    let held = this.spare.length;
    for (const tile of this.tiles.values()) if (tile.sheet) held++;
    while (held > count && this.spare.length) {
      this.discard(this.spare.pop()!);
      held--;
    }
    if (held <= count) return;
    const idle = [...this.tiles].filter(([, tile]) => tile.sheet && tile.used !== this.clock).sort((a, b) => a[1].used - b[1].used);
    for (const [id, tile] of idle) {
      if (held <= count) break;
      this.discard(tile.sheet!);
      this.tiles.delete(id);
      held--;
    }
  }

  private retire(sheet: Sheet): void {
    this.group.remove(sheet.mesh);
    this.spare.push(sheet);
  }

  private discard(sheet: Sheet): void {
    this.group.remove(sheet.mesh);
    sheet.target.dispose();
    (sheet.mesh.material as THREE.Material).dispose();
  }

  private sheet(): Sheet {
    const spare = this.spare.pop();
    if (spare) return spare;
    // Stored sRGB-encoded (8 bits of linear colour band in the dark), filtered as linear light.
    const target = new THREE.WebGLRenderTarget(TILE_SIZE, TILE_SIZE, { depthBuffer: false, colorSpace: THREE.SRGBColorSpace });
    const material = new THREE.ShaderMaterial({
      uniforms: { tTile: { value: target.texture }, uInset: this.inset },
      vertexShader: COMPOSE_VERTEX,
      fragmentShader: COMPOSE_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    return { target, mesh: new THREE.Mesh(this.geometry, material) };
  }

  /** Every tile in view is there: `draw` shows the whole view. */
  get ready(): boolean {
    return this.view !== null && this.missingVisible === 0;
  }

  /** Tiles in view that are not painted yet. */
  get missingInView(): number {
    return this.missingVisible;
  }

  /** Tiles the view needs (in it or about to come into it) that are not painted yet. */
  get pending(): number {
    return this.missing.length;
  }

  /** Paints up to `count` of the missing tiles, the ones in view first. Returns how many. */
  paint(count: number): number {
    const view = this.view;
    if (!view) return 0;
    const { camera, size } = this;
    const texel = size / INTERIOR;
    const half = (TILE_SIZE / 2) * texel;
    let painted = 0;
    while (painted < count && this.missing.length) {
      const { i, j, visible } = this.missing.shift()!;
      if (visible) this.missingVisible--;
      const x = (i + 0.5) * size, z = (j + 0.5) * size;
      camera.left = camera.bottom = -half;
      camera.right = camera.top = half;
      camera.near = view.near;
      camera.far = view.far;
      camera.position.set(x, view.eye, z);
      camera.lookAt(x, view.eye - 1, z);
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld();
      const sheet = this.sheet();
      this.painter(camera, sheet.target, this.scale, view.pixel);
      sheet.mesh.position.set(x, 0, z);
      sheet.mesh.scale.set(size, 1, size);
      this.group.add(sheet.mesh);
      this.tiles.set(`${i},${j}`, { sheet, used: this.clock });
      painted++;
    }
    return painted;
  }

  /** Draws the view from its tiles (all of them have to be there: `ready`). */
  draw(renderer: THREE.WebGLRenderer, camera: THREE.Camera): void {
    const view = this.view;
    if (!view) return;
    const [dx, dz] = snapShift(view);
    this.group.position.set(dx, view.y, dz);
    renderer.render(this.scene, camera);
  }

  /** Lets go of every tile (the view is no longer one that tiles can show). */
  clear(): void {
    for (const tile of this.tiles.values()) if (tile.sheet) this.discard(tile.sheet);
    for (const sheet of this.spare) this.discard(sheet);
    this.tiles.clear();
    this.spare.length = 0;
    this.missing = [];
    this.missingVisible = 0;
    this.view = null;
    this.key = "";
  }

  dispose(): void {
    this.clear();
    this.geometry.dispose();
  }
}
