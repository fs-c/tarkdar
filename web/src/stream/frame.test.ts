import { notifyOnFrame, onFlush } from "./frame";

describe("notifyOnFrame", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    onFlush(null);
    vi.useRealTimers();
  });

  it("tells each listener once per flush, however often it was asked", async () => {
    const a = vi.fn(), b = vi.fn();
    const flushes: number[] = [];
    onFlush((f) => flushes.push(f.waitedMs));
    for (let i = 0; i < 30; i++) notifyOnFrame(a); // a burst of messages
    notifyOnFrame(b);
    expect(a).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100); // no frames here (node): the fallback timer flushes
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(flushes).toHaveLength(1);

    notifyOnFrame(a);
    await vi.advanceTimersByTimeAsync(100);
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(1);
  });
});
