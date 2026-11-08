// Camera over the map image: a centre (in map pixels) and a zoom (screen px per map px).

export class View {
  centerU = 0;
  centerV = 0;
  zoom = 1;
  follow = true;
  width = 0; // canvas size in CSS pixels
  height = 0;

  toScreen(u: number, v: number): [number, number] {
    return [(u - this.centerU) * this.zoom + this.width / 2, (v - this.centerV) * this.zoom + this.height / 2];
  }

  toMap(x: number, y: number): [number, number] {
    return [(x - this.width / 2) / this.zoom + this.centerU, (y - this.height / 2) / this.zoom + this.centerV];
  }

  panBy(dx: number, dy: number): void {
    this.centerU -= dx / this.zoom;
    this.centerV -= dy / this.zoom;
    this.follow = false;
  }

  /** Zooms by `factor`, keeping the map point under screen position (x, y) fixed. */
  zoomAt(factor: number, x: number, y: number): void {
    const [u, v] = this.toMap(x, y);
    this.zoom = Math.min(16, Math.max(0.05, this.zoom * factor));
    const [u2, v2] = this.toMap(x, y);
    this.centerU += u - u2;
    this.centerV += v - v2;
  }
}
