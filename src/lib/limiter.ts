/** Outcome of one item in a bounded-concurrency run. Never throws; always settles. */
export type Settled<R> =
  | { readonly ok: true; readonly index: number; readonly value: R }
  | { readonly ok: false; readonly index: number; readonly error: unknown };

/**
 * Runs `worker` over `items` with at most `limit` in flight at once, preserving
 * input order in the results.
 *
 * Uses a fixed pool of workers pulling from a shared cursor rather than
 * chunking. Chunking stalls on the slowest item in each chunk; a pool keeps
 * every slot busy, which matters a lot when Discord rate-limits one route but
 * not the others.
 *
 * `stopOnError` abandons *unstarted* work after the first failure. Requests
 * already in flight are still awaited, so their results are never lost.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  options: { stopOnError?: boolean; signal?: AbortSignal } = {},
): Promise<Array<Settled<R>>> {
  const { stopOnError = false, signal } = options;
  const results = new Array<Settled<R>>(items.length);
  const poolSize = Math.max(1, Math.min(limit, items.length));

  let cursor = 0;
  let aborted = false;

  const runOne = async (): Promise<void> => {
    for (;;) {
      if (aborted || signal?.aborted === true) return;

      const index = cursor++;
      if (index >= items.length) return;

      try {
        results[index] = { ok: true, index, value: await worker(items[index] as T, index) };
      } catch (error) {
        results[index] = { ok: false, index, error };
        if (stopOnError) {
          aborted = true;
          return;
        }
      }
    }
  };

  await Promise.all(Array.from({ length: poolSize }, runOne));

  // With stopOnError or cancellation, trailing slots may never have been
  // claimed. Mark them explicitly so callers always get one entry per item.
  for (let i = 0; i < results.length; i++) {
    results[i] ??= { ok: false, index: i, error: skipped(signal) };
  }

  return results;
}

/**
 * Runs groups of work where items in the same group must not overlap, but
 * different groups may run together.
 *
 * Discord rate-limits per route+method+major-parameter ("bucket"), and the REST
 * client serialises anything sharing a bucket anyway. Firing twenty calls at
 * one bucket therefore buys no speed - it just drains the allowance and makes
 * everything afterwards wait for a reset. Spreading the same calls across
 * buckets is what actually parallelises.
 */
export async function mapLanes<T, R>(
  lanes: ReadonlyArray<readonly T[]>,
  limit: number,
  worker: (item: T) => Promise<R>,
  options: { stopOnError?: boolean; signal?: AbortSignal } = {},
): Promise<Array<Array<Settled<R>>>> {
  const { stopOnError = false, signal } = options;
  let halted = false;

  const runLane = async (lane: readonly T[]): Promise<Array<Settled<R>>> => {
    const out: Array<Settled<R>> = [];

    for (const [index, item] of lane.entries()) {
      if (halted || signal?.aborted === true) {
        out.push({ ok: false, index, error: skipped(signal) });
        continue;
      }

      try {
        out.push({ ok: true, index, value: await worker(item) });
      } catch (error) {
        out.push({ ok: false, index, error });
        if (stopOnError) halted = true;
      }
    }

    return out;
  };

  // Lanes are never cut short here - each one records its own skips - so the
  // results always line up one-to-one with the lane items.
  const settled = await mapWithConcurrency(lanes, limit, runLane);
  return settled.map((result, i) =>
    result.ok ? result.value : (lanes[i] ?? []).map((_, index) => ({ ok: false as const, index, error: result.error })),
  );
}

function skipped(signal: AbortSignal | undefined): Error {
  return new Error(
    signal?.aborted === true
      ? "Skipped: the call was cancelled."
      : "Skipped: an earlier operation failed and stop_on_error was true.",
  );
}
