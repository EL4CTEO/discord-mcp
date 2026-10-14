import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TtlCache } from "../src/discord/cache.js";

/** A promise the test settles by hand, so writes can land while a load is in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

let now = 0;

beforeEach(() => {
  now = 1_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TtlCache hit, miss and expiry", () => {
  it("returns undefined on a miss and the value on a hit", () => {
    const cache = new TtlCache<string>(100);
    expect(cache.get("a")).toBeUndefined();

    cache.set("a", "alpha");
    expect(cache.get("a")).toBe("alpha");
    expect(cache.size).toBe(1);
  });

  it("expires entries once the TTL has passed", () => {
    const cache = new TtlCache<string>(100);
    cache.set("a", "alpha");

    now += 99;
    expect(cache.get("a")).toBe("alpha");

    now += 1;
    expect(cache.get("a")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("update keeps the original expiry and does nothing on a miss", () => {
    const cache = new TtlCache<string>(100);
    cache.update("a", (v) => `${v}!`);
    expect(cache.size).toBe(0);

    cache.set("a", "alpha");
    now += 50;
    cache.update("a", (v) => `${v}!`);
    expect(cache.get("a")).toBe("alpha!");

    now += 50;
    expect(cache.get("a")).toBeUndefined();
  });
});

describe("TtlCache fetch", () => {
  it("loads on a miss and serves later reads from the cache", async () => {
    const cache = new TtlCache<number>(1_000);
    const load = vi.fn(async () => 7);

    expect(await cache.fetch("a", load)).toBe(7);
    expect(await cache.fetch("a", load)).toBe(7);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("shares one load between concurrent misses for the same key", async () => {
    const cache = new TtlCache<number>(1_000);
    const pending = deferred<number>();
    const load = vi.fn(() => pending.promise);

    const first = cache.fetch("a", load);
    const second = cache.fetch("a", load);
    expect(load).toHaveBeenCalledTimes(1);

    pending.resolve(5);
    expect(await first).toBe(5);
    expect(await second).toBe(5);
    expect(cache.get("a")).toBe(5);
  });

  it("does not cache a result when the key is deleted mid-flight, and reloads afterwards", async () => {
    const cache = new TtlCache<string>(1_000);
    const pending = deferred<string>();
    const load = vi
      .fn<() => Promise<string>>()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce("fresh");

    const inFlight = cache.fetch("a", load);
    cache.delete("a");
    pending.resolve("stale");

    expect(await inFlight).toBe("stale");
    expect(cache.get("a")).toBeUndefined();

    expect(await cache.fetch("a", load)).toBe("fresh");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not cache a result when update misses mid-flight", async () => {
    const cache = new TtlCache<string>(1_000);
    const pending = deferred<string>();

    const inFlight = cache.fetch("a", () => pending.promise);
    cache.update("a", (v) => `${v}!`);
    pending.resolve("loaded");

    expect(await inFlight).toBe("loaded");
    expect(cache.get("a")).toBeUndefined();
  });

  it("does not cache a result when the cache is cleared mid-flight", async () => {
    const cache = new TtlCache<string>(1_000);
    const pending = deferred<string>();

    const inFlight = cache.fetch("a", () => pending.promise);
    cache.clear();
    pending.resolve("loaded");

    expect(await inFlight).toBe("loaded");
    expect(cache.get("a")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("keeps a value written mid-flight over the older loaded result", async () => {
    const cache = new TtlCache<string>(1_000);
    const pending = deferred<string>();

    const inFlight = cache.fetch("a", () => pending.promise);
    cache.set("a", "written");
    pending.resolve("loaded");

    expect(await inFlight).toBe("loaded");
    expect(cache.get("a")).toBe("written");
  });

  it("does not join a stale in-flight load after the key was invalidated", async () => {
    const cache = new TtlCache<string>(1_000);
    const stale = deferred<string>();
    const fresh = deferred<string>();
    const load = vi
      .fn<() => Promise<string>>()
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(fresh.promise);

    const staleCall = cache.fetch("a", load);
    cache.delete("a");

    const freshCall = cache.fetch("a", load);
    expect(load).toHaveBeenCalledTimes(2);

    // The stale load finishing must not remove the newer in-flight entry...
    stale.resolve("old");
    expect(await staleCall).toBe("old");

    // ...so a third caller still joins the fresh load instead of starting another.
    const joined = cache.fetch("a", load);
    expect(load).toHaveBeenCalledTimes(2);

    fresh.resolve("new");
    expect(await freshCall).toBe("new");
    expect(await joined).toBe("new");
    expect(cache.get("a")).toBe("new");
  });

  it("clear mid-flight drops unrelated entries as well", async () => {
    const cache = new TtlCache<string>(1_000);
    cache.set("other", "kept");
    const pending = deferred<string>();

    const inFlight = cache.fetch("a", () => pending.promise);
    cache.clear();
    pending.resolve("loaded");

    expect(await inFlight).toBe("loaded");
    expect(cache.get("other")).toBeUndefined();
  });
});

describe("TtlCache capacity", () => {
  it("overwriting an existing key at capacity keeps the other entries", () => {
    const cache = new TtlCache<number>(1_000, 2);
    cache.set("a", 1);
    cache.set("b", 2);

    cache.set("a", 10);

    expect(cache.get("a")).toBe(10);
    expect(cache.get("b")).toBe(2);
    expect(cache.size).toBe(2);
  });

  it("evicts the least recently used key when a new key arrives at capacity", () => {
    const cache = new TtlCache<number>(1_000, 2);
    cache.set("a", 1);
    cache.set("b", 2);

    // Reading "a" makes "b" the least recently used entry.
    expect(cache.get("a")).toBe(1);
    cache.set("c", 3);

    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    expect(cache.get("c")).toBe(3);
    expect(cache.size).toBe(2);
  });

  it("overwriting a key counts as a recent use", () => {
    const cache = new TtlCache<number>(1_000, 2);
    cache.set("a", 1);
    cache.set("b", 2);

    cache.set("a", 11);
    cache.set("c", 3);

    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(11);
    expect(cache.get("c")).toBe(3);
  });
});
