// Greedy screen-space label placement: labels are offered in priority order, each takes the first
// candidate position that doesn't overlap a label already placed, and is dropped if none is free.
// How many labels show is thus driven by local density rather than by zoom.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const CELL = 32;

const overlaps = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Placed rectangles, bucketed into a coarse grid so collision checks stay cheap. */
export class LabelPlacer {
  private readonly cells = new Map<string, Rect[]>();

  /** Marks `r` as taken, unconditionally (for labels that must always show). */
  reserve(r: Rect): void {
    this.forCells(r, (key) => {
      const bucket = this.cells.get(key);
      if (bucket) bucket.push(r);
      else this.cells.set(key, [r]);
      return false;
    });
  }

  free(r: Rect): boolean {
    return !this.forCells(r, (key) => this.cells.get(key)?.some((o) => overlaps(o, r)) ?? false);
  }

  /** Reserves and returns the first free candidate, or null if all collide. */
  place(candidates: Iterable<Rect>): Rect | null {
    for (const r of candidates) {
      if (this.free(r)) {
        this.reserve(r);
        return r;
      }
    }
    return null;
  }

  /** Calls `fn` for each grid cell `r` touches; stops early (returning true) if `fn` returns true. */
  private forCells(r: Rect, fn: (key: string) => boolean): boolean {
    const x0 = Math.floor(r.x / CELL), x1 = Math.floor((r.x + r.w) / CELL);
    const y0 = Math.floor(r.y / CELL), y1 = Math.floor((r.y + r.h) / CELL);
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) if (fn(`${cx},${cy}`)) return true;
    return false;
  }
}

/** Candidate label boxes around a marker at (x, y), in preference order: right, left, above, below,
 *  then the right-hand diagonals. `gap` is the distance from the marker centre. */
export function candidatesAround(x: number, y: number, w: number, h: number, gap: number): [Rect, ...Rect[]] {
  return [
    { x: x + gap, y: y - h / 2, w, h },
    { x: x - gap - w, y: y - h / 2, w, h },
    { x: x - w / 2, y: y - gap - h, w, h },
    { x: x - w / 2, y: y + gap, w, h },
    { x: x + gap - 2, y: y - gap - h + 2, w, h },
    { x: x + gap - 2, y: y + gap - 2, w, h },
  ];
}
