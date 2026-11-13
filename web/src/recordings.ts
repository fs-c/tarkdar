// Raid recordings from the backend (GET /api/recordings): listing them and loading one into a Timeline.

import { type RecordedMessage, type RecordingInfo, withoutContainerContents } from "./protocol";
import { Timeline } from "./timeline";

export async function fetchRecordings(): Promise<RecordingInfo[]> {
  const res = await fetch("/api/recordings", { cache: "no-store" });
  if (!res.ok) throw new Error(`recordings: HTTP ${res.status}`);
  return (await res.json()) as RecordingInfo[];
}

/** Feeds every line of a recording (plain or gzipped) to `onLine`, as it streams in. */
export async function readRecording(name: string, onLine: (line: string) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch(`/api/recordings/${encodeURIComponent(name)}`, { cache: "no-store", signal });
  if (!res.ok || !res.body) throw new Error(`recording ${name}: HTTP ${res.status}`);
  let stream = res.body as ReadableStream<BufferSource>;
  if (name.endsWith(".gz")) stream = stream.pipeThrough(new DecompressionStream("gzip")) as ReadableStream<BufferSource>;
  await splitLines(stream.pipeThrough(new TextDecoderStream()), onLine);
}

export async function splitLines(stream: ReadableStream<string>, onLine: (line: string) => void): Promise<void> {
  const reader = stream.getReader();
  let rest = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    rest += value;
    let nl: number;
    while ((nl = rest.indexOf("\n")) >= 0) {
      const line = rest.slice(0, nl);
      rest = rest.slice(nl + 1);
      if (line) onLine(line);
    }
  }
  if (rest) onLine(rest); // a last line without newline (possibly cut off: ingest skips it then)
}

/** Parses one recording line; null for lines that aren't messages (e.g. cut off). */
export function parseLine(line: string): RecordedMessage | null {
  try {
    const m = JSON.parse(line) as Partial<RecordedMessage> | null;
    if (!m || typeof m !== "object" || typeof m.type !== "string" || typeof m.t !== "number") return null;
    return withoutContainerContents(m as RecordedMessage);
  } catch {
    return null;
  }
}

/** Ingests recording lines into a timeline. */
export function ingestLines(timeline: Timeline, lines: Iterable<string>): void {
  for (const line of lines) {
    const msg = parseLine(line);
    if (msg) timeline.ingest(msg);
  }
}

export async function loadRecording(name: string, signal?: AbortSignal): Promise<Timeline> {
  const timeline = new Timeline();
  await readRecording(
    name,
    (line) => {
      const msg = parseLine(line);
      if (msg) timeline.ingest(msg);
    },
    signal,
  );
  return timeline;
}
