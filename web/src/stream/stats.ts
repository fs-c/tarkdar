// How far behind the backend the page is, logged to the console every few seconds:
//  - lag: a message's age when it arrives (now − its `t`, which the backend stamps when it sends it).
//    It includes the offset between the two machines' clocks, so the spread (max − min) is the part
//    that matters when the page runs on another machine.
//  - handle: parsing a message and taking it into the state and timeline.
//  - render: a batched flush (frame.ts), with React's render of it; wait: how long it waited for
//    its frame.
// Logged as a warning when something looks wrong (lag spread, renders or handling too slow).

import { type FlushInfo, onFlush } from "./frame";

const REPORT_MS = 5000;
const WARN_LAG_SPREAD_MS = 250;
const WARN_RENDER_MS = 50;
const WARN_HANDLE_MS = 20;

class Spread {
  n = 0;
  sum = 0;
  min = Infinity;
  max = -Infinity;
  add(v: number): void {
    this.n++;
    this.sum += v;
    if (v < this.min) this.min = v;
    if (v > this.max) this.max = v;
  }
  text(): string {
    return this.n ? `avg ${(this.sum / this.n).toFixed(1)}, min ${this.min.toFixed(0)}, max ${this.max.toFixed(0)} ms` : "-";
  }
}

export class StreamStats {
  private lag = new Spread();
  private handle = new Spread();
  private render = new Spread();
  private wait = new Spread();
  private bytes = 0;
  private biggest = { type: "", bytes: 0 };
  private started = performance.now();
  private timer: ReturnType<typeof setInterval> | undefined;

  start(): void {
    onFlush((f) => this.onFlush(f));
    this.timer = setInterval(() => this.report(), REPORT_MS);
  }

  stop(): void {
    onFlush(null);
    clearInterval(this.timer);
  }

  /** A message that arrived: its time, size and how long taking it in took. */
  message(type: string, t: number | undefined, bytes: number, handleMs: number): void {
    if (typeof t === "number") this.lag.add(Date.now() - t);
    this.handle.add(handleMs);
    this.bytes += bytes;
    if (bytes > this.biggest.bytes) this.biggest = { type, bytes };
  }

  private onFlush(f: FlushInfo): void {
    this.render.add(f.renderMs);
    this.wait.add(f.waitedMs);
  }

  private report(): void {
    const seconds = (performance.now() - this.started) / 1000;
    if (this.lag.n > 0) {
      const spread = this.lag.max - this.lag.min;
      const bad = spread > WARN_LAG_SPREAD_MS || this.render.max > WARN_RENDER_MS || this.handle.max > WARN_HANDLE_MS;
      const text =
        `stream: ${(this.lag.n / seconds).toFixed(0)} msg/s, ${(this.bytes / 1024 / seconds).toFixed(0)} KiB/s ` +
        `(largest ${this.biggest.type} ${(this.biggest.bytes / 1024).toFixed(0)} KiB)\n` +
        `  lag ${this.lag.text()} (spread ${spread.toFixed(0)} ms)\n  handle ${this.handle.text()}\n` +
        `  render ${this.render.n} × ${this.render.text()}\n  wait ${this.wait.text()}`;
      if (bad) console.warn(text);
      else console.debug(text);
    }
    this.lag = new Spread();
    this.handle = new Spread();
    this.render = new Spread();
    this.wait = new Spread();
    this.bytes = 0;
    this.biggest = { type: "", bytes: 0 };
    this.started = performance.now();
  }
}
