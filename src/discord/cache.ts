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
  // Bumped by every write to a key. A load that started before the write read
  // the old state, so caching its result would silently undo the write.
  readonly #generation = new Map<string, number>();
  // Bumped by clear(), which invalidates every key at once without visiting each one.
  #epoch = 0;
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
    this.#touch(key);
    this.#put(key, value);
  }

  /**
   * Resolve through the cache, only invoking `load` on a miss.
   *
   * Concurrent misses for the same key share a single `load` call. Without
   * this, a batch of 20 operations starting on a cold cache fires 20 identical
   * channel listings at Discord, burning the rate-limit bucket that the real
   * work then has to queue behind.
   *
   * If the key is written or cleared while `load` is running, the caller still
   * gets the loaded value, but it is not cached, so the newer write wins.
   */
  async fetch(key: string, load: () => Promise<V>): Promise<V> {
    const hit = this.get(key);
    if (hit !== undefined) return hit;

    const inFlight = this.#inFlight.get(key);
    if (inFlight) return inFlight;

    const generation = this.#generation.get(key) ?? 0;
    const epoch = this.#epoch;

    const request: Promise<V> = load()
      .then((value) => {
        if ((this.#generation.get(key) ?? 0) === generation && this.#epoch === epoch) {
          this.#put(key, value);
        }
        return value;
      })
      .finally(() => {
        // A newer request may have replaced this one after an invalidation.
        // Only remove our own entry, or that newer request becomes unjoinable.
        if (this.#inFlight.get(key) === request) this.#inFlight.delete(key);
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
    this.#touch(key);
    const entry = this.#store.get(key);
    if (!entry || entry.expiresAt <= Date.now()) return;
    entry.value = change(entry.value);
  }

  delete(key: string): void {
    this.#touch(key);
    this.#store.delete(key);
  }

  clear(): void {
    this.#epoch += 1;
    this.#generation.clear();
    this.#inFlight.clear();
    this.#store.clear();
  }

  get size(): number {
    return this.#store.size;
  }

  /** Marks a key as written: any load still running for it is now stale. */
  #touch(key: string): void {
    this.#generation.set(key, (this.#generation.get(key) ?? 0) + 1);
    this.#inFlight.delete(key);
  }

  /** Stores a value without marking the key as written, for fetch's own result. */
  #put(key: string, value: V): void {
    // Only a brand-new key can push out another entry. Overwriting an existing
    // key must not evict an unrelated one from a full cache.
    if (!this.#store.has(key) && this.#store.size >= this.#maxEntries) {
      const oldest = this.#store.keys().next();
      if (!oldest.done) this.#store.delete(oldest.value);
    }
    // Delete before set so an overwrite moves the key to the most-recent slot.
    this.#store.delete(key);
    this.#store.set(key, { value, expiresAt: Date.now() + this.#ttlMs });
  }
}
