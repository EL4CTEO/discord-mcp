import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "../src/lib/limiter.js";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("mapWithConcurrency", () => {
  it("preserves input order regardless of completion order", async () => {
    const results = await mapWithConcurrency([30, 10, 20], 3, async (ms) => {
      await tick(ms);
      return ms;
    });

    expect(results.map((r) => (r.ok ? r.value : null))).toEqual([30, 10, 20]);
  });

  it("never exceeds the concurrency limit", async () => {
    let active = 0;
    let peak = 0;

    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await tick(5);
      active -= 1;
    });

    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it("isolates failures so successful items still return", async () => {
    const results = await mapWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error("boom");
      return n * 10;
    });

    expect(results[0]).toMatchObject({ ok: true, value: 10 });
    expect(results[1]).toMatchObject({ ok: false });
    expect(results[2]).toMatchObject({ ok: true, value: 30 });
  });

  it("stops scheduling new work after a failure when asked", async () => {
    let started = 0;

    const results = await mapWithConcurrency(
      Array.from({ length: 20 }, (_, i) => i),
      1,
      async (n) => {
        started += 1;
        if (n === 1) throw new Error("boom");
        return n;
      },
      { stopOnError: true },
    );

    expect(started).toBeLessThan(20);
    expect(results).toHaveLength(20);
    expect(results.every((r) => r !== undefined)).toBe(true);
  });

  it("handles an empty input list", async () => {
    await expect(mapWithConcurrency([], 4, async () => 1)).resolves.toEqual([]);
  });
});
