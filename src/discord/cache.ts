interface Entry<V> {
  value: V;
  expiresAt: number;
}

/**
 * Small TTL cache with an LRU-ish bound, used for name -> id resolution.
 *
 * Resolving "breakout block" or "#general" costs a full guild/channel listing.
 * Without caching, a five-step workflow would repeat that listing five times.
 * Entries are deliberately short-lived so renames are picked up quickly.
 */
export class TtlCache<V> {
  readonly #store = new Map<string, Entry<V>>();
  readonly #inFlight = new Map<string, Promise<V>>();
  readonly #ttlMs: number;
  readonly #maxEntries: number;

  constructor(ttlMs: number, maxEntries = 500) {
    this.#ttlMs = ttlMs;
    this.#maxEntries = maxEntries;
  }

  get(key: string): V | undefined {
    const entry = this.#store.get(key);
    if (!entry) return undefined;

    if (entry.expiresAt <= Date.now()) {
      this.#store.delete(key);
      return undefined;
    }

    // Re-insert so iteration order tracks recency for the eviction below.
    this.#store.delete(key);
    this.#store.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V): void {
    if (this.#store.size >= this.#maxEntries) {
      const oldest = this.#store.keys().next();
      if (!oldest.done) this.#store.delete(oldest.value);
    }
    this.#store.set(key, { value, expiresAt: Date.now() + this.#ttlMs });
  }

  /**
   * Resolve through the cache, only invoking `load` on a miss.
   *
   * Concurrent misses for the same key share a single `load` call. Without
   * this, a batch of 20 operations starting on a cold cache fires 20 identical
   * channel listings at Discord, burning the rate-limit bucket that the real
   * work then has to queue behind.
   */
  async fetch(key: string, load: () => Promise<V>): Promise<V> {
    const hit = this.get(key);
    if (hit !== undefined) return hit;

    const inFlight = this.#inFlight.get(key);
    if (inFlight) return inFlight;

    const request = load()
      .then((value) => {
        this.set(key, value);
        return value;
      })
      .finally(() => {
        this.#inFlight.delete(key);
      });

    this.#inFlight.set(key, request);
    return request;
  }

  /**
   * Replaces a cached value in place, keeping its expiry, and only if it is
   * cached. Used to fold the result of a create/edit/delete into a listing
   * instead of throwing the listing away and paying for a refetch.
   */
  update(key: string, change: (value: V) => V): void {
    const entry = this.#store.get(key);
    if (!entry || entry.expiresAt <= Date.now()) return;
    entry.value = change(entry.value);
  }

  delete(key: string): void {
    this.#store.delete(key);
  }

  clear(): void {
    this.#store.clear();
  }

  get size(): number {
    return this.#store.size;
  }
}
