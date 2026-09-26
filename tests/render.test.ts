import { describe, expect, it } from "vitest";
import { describeTrim, fitToBudget } from "../src/lib/render.js";

describe("fitToBudget", () => {
  it("returns small data unchanged and compact", () => {
    const fitted = fitToBudget({ a: [1, 2] }, 1000);
    expect(fitted.text).toBe('{"a":[1,2]}');
    expect(describeTrim(fitted.stats)).toBeUndefined();
  });

  it("keeps every batch row, trimming only the heavy ones", () => {
    // A batch where one operation returned a huge payload and the rest are tiny.
    const rows = [
      { index: 0, ok: true, data: Array.from({ length: 400 }, (_, i) => ({ id: i, text: "x".repeat(40) })) },
      ...Array.from({ length: 9 }, (_, i) => ({ index: i + 1, ok: true, summary: "done" })),
    ];
    const fitted = fitToBudget(rows, 4000);
    const value = fitted.value as Array<{ index: number }>;

    expect(fitted.text.length).toBeLessThanOrEqual(4000);
    expect(value.map((r) => r.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(fitted.stats.omitted).toBeGreaterThan(0);
  });

  it("drops trailing items of a long flat list and counts them", () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({ id: i, text: "y".repeat(60) }));
    const fitted = fitToBudget(rows, 3000);

    expect(fitted.text.length).toBeLessThanOrEqual(3000);
    expect((fitted.value as unknown[]).length + fitted.stats.omitted).toBe(500);
  });

  it("clips a single huge string", () => {
    const fitted = fitToBudget({ content: "z".repeat(10_000) }, 500);
    expect(fitted.text.length).toBeLessThanOrEqual(500);
    expect(fitted.stats.clipped).toBe(1);
    expect(describeTrim(fitted.stats)).toContain("clipped");
  });
});
