// The current raid's timeline, built from the live stream. A client that joins mid-raid fills in
// what it missed from the backend's recording of the raid: it keeps ingesting live messages into a
// stream-only timeline meanwhile, then builds one from the recording, adds the live messages on
// top (the timeline drops the ones the recording already had) and swaps it in.

import type { Message, RecordedMessage, RecordingInfo } from "./protocol";
import { Timeline } from "./timeline";

export interface Backfill {
  /** The recording being written right now, if any. */
  active(): Promise<RecordingInfo | null>;
  /** Ingests that recording's lines into `into`. */
  read(name: string, into: Timeline, signal: AbortSignal): Promise<void>;
}

export class LiveTimeline {
  timeline: Timeline | null = null;
  /** Fetching the raid's recording so far. */
  backfilling = false;
  private raid: number | null = null;
  /** The latest message per type since the last status: a raid's first snapshots can come before its status. */
  private early = new Map<string, Message>();
  /** Live messages since the raid's timeline started, replayed onto the backfilled one. */
  private buffer: Message[] | null = null;
  private abort: AbortController | null = null;
  private version = 0;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly backfill: Backfill | null) {}

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  /** Changes on every update (for useSyncExternalStore). */
  getVersion = (): number => this.version;

  handle(msg: Message): void {
    if (msg.type === "hello") return;
    if (msg.type === "status") {
      const raid = msg.data.state === "inRaid" ? msg.raid : null;
      if (raid === null) {
        if (this.timeline) this.stop();
        this.early.clear();
        return;
      }
      if (raid !== this.raid) this.start(raid);
      this.ingest(msg);
      return;
    }
    if (this.timeline && msg.raid === this.raid) this.ingest(msg);
    else if (msg.raid !== null) this.early.set(msg.type, msg);
  }

  dispose(): void {
    this.abort?.abort();
    this.listeners.clear();
  }

  private ingest(msg: Message): void {
    if (!this.timeline) return;
    this.buffer?.push(msg);
    if (this.timeline.ingest(msg)) this.changed();
  }

  private changed(): void {
    this.version++;
    for (const l of this.listeners) l();
  }

  private stop(): void {
    this.abort?.abort();
    this.abort = null;
    this.timeline = null;
    this.raid = null;
    this.buffer = null;
    this.backfilling = false;
    this.changed();
  }

  private start(raid: number): void {
    this.abort?.abort();
    this.raid = raid;
    this.timeline = new Timeline();
    const early = [...this.early.values()].filter((m) => m.raid === raid).sort((a, b) => a.t - b.t);
    this.early.clear();
    for (const m of early) this.timeline.ingest(m);
    this.changed();
    if (this.backfill) void this.runBackfill(raid, early);
  }

  private async runBackfill(raid: number, early: Message[]): Promise<void> {
    const abort = new AbortController();
    this.abort = abort;
    this.buffer = [...early];
    this.backfilling = true;
    this.changed();
    try {
      const active = await this.backfill!.active();
      if (abort.signal.aborted) return;
      if (active) {
        const full = new Timeline();
        await this.backfill!.read(active.name, full, abort.signal);
        // Another raid's recording (the backend restarted, or the raid just changed): not ours.
        if (abort.signal.aborted || full.raid !== raid) return;
        for (const m of this.buffer ?? []) full.ingest(m as RecordedMessage);
        this.timeline = full;
      }
    } catch (e) {
      if (!abort.signal.aborted) console.warn("couldn't load the raid so far", e);
    } finally {
      if (this.abort === abort) {
        this.abort = null;
        this.buffer = null;
        this.backfilling = false;
        this.changed();
      }
    }
  }
}
