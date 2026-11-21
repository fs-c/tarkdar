// Change notifications, batched to at most one flush per frame.
//
// Every WebSocket message is its own task, and React renders a useSyncExternalStore change right
// away. Notified per message, a render slower than the message interval (~33 ms) makes the browser
// queue messages faster than the page works them off, and the page drifts further and further
// behind the game. Batched, the state still takes every message as it comes, but React renders once
// per frame with whatever arrived since: a slow render costs frames, not latency.

/** Flush at least this often (ms), also when frames don't come. */
const FALLBACK_MS = 100;

// A hidden tab has no frames and throttles timers (to once a second, or less), but it still configures
// the overlay: there a message-channel task flushes, which isn't throttled and still comes after the
// messages already queued.
const channel = typeof MessageChannel === "function" ? new MessageChannel() : null;
if (channel) channel.port1.onmessage = () => flush();
const hidden = (): boolean => typeof document !== "undefined" && document.hidden;

const pending = new Set<() => void>();
let scheduled = false;
let frame = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let flushListener: ((info: FlushInfo) => void) | null = null;
let firstQueuedAt = 0;

export interface FlushInfo {
  /** How long the first notification of this flush waited for it (ms). */
  waitedMs: number;
  /** The listeners' run and the render React did right after (ms). */
  renderMs: number;
}

/** Calls `notify` on the next flush (once, however often it's asked for until then). */
export function notifyOnFrame(notify: () => void): void {
  pending.add(notify);
  if (scheduled) return;
  scheduled = true;
  firstQueuedAt = performance.now();
  if (channel && hidden()) {
    channel.port2.postMessage(null);
    return;
  }
  if (typeof requestAnimationFrame === "function") frame = requestAnimationFrame(flush);
  timer = setTimeout(flush, FALLBACK_MS);
}

/** Told about every flush (one listener: the stream's stats). */
export function onFlush(listener: ((info: FlushInfo) => void) | null): void {
  flushListener = listener;
}

function flush(): void {
  if (!scheduled) return;
  scheduled = false;
  if (frame && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
  clearTimeout(timer);
  frame = 0;
  const start = performance.now();
  const waitedMs = start - firstQueuedAt;
  const notifies = [...pending];
  pending.clear();
  // In one task, so React batches them all into one render.
  for (const n of notifies) n();
  // React renders the batch in a microtask queued by the notifications: this one runs after it.
  const listener = flushListener;
  if (listener) queueMicrotask(() => listener({ waitedMs, renderMs: performance.now() - start }));
}
