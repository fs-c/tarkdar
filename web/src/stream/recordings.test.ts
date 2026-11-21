import { splitLines } from "./recordings";

const streamOf = (chunks: string[]): ReadableStream<string> =>
  new ReadableStream({
    start(c) {
      for (const chunk of chunks) c.enqueue(chunk);
      c.close();
    },
  });

describe("splitLines", () => {
  it("splits lines across chunks, skips empty ones and keeps a last line without newline", async () => {
    const lines: string[] = [];
    await splitLines(streamOf(["a\nb", "c\n\nd\n", "e"]), (l) => lines.push(l));
    expect(lines).toEqual(["a", "bc", "d", "e"]);
  });

  it("gets through a big chunk with turns for the page in between", async () => {
    const n = 20_000;
    let seen = 0;
    await splitLines(streamOf([Array.from({ length: n }, (_, i) => `{"i":${i}}`).join("\n") + "\n"]), (l) => {
      expect(JSON.parse(l).i).toBe(seen++);
    });
    expect(seen).toBe(n);
  });
});
