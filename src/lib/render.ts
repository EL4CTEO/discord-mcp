/**
 * Shrinks arbitrary JSON data until it serialises within a character budget.
 *
 * A flat prefix cut is the wrong tool for most tool output here: a batch of
 * 20 message reads would lose its last operations entirely, and the agent
 * would reason as if they never ran. Instead the budget is shared out
 * ("water-filled") across siblings, so every entry keeps its identity and only
 * the largest ones give up detail. Only when a list is so long that each item
 * would be reduced to a stub are trailing items dropped - and then counted, so
 * the agent knows to narrow its query.
 */

/** Below this per-item share, dropping trailing items beats mangling them all. */
const MIN_ITEM_SHARE = 200;

export interface FitStats {
  /** List items dropped from the end of an array. */
  omitted: number;
  /** Strings shortened to fit. */
  clipped: number;
}

export interface Fitted {
  readonly value: unknown;
  readonly text: string;
  readonly stats: FitStats;
}

export function fitToBudget(data: unknown, budget: number): Fitted {
  const stats: FitStats = { omitted: 0, clipped: 0 };
  const value = shrink(data, Math.max(budget, 16), stats);
  let text = json(value);

  // Last-resort guarantee for shapes the heuristics could not reduce.
  if (text.length > budget) {
    text = `${text.slice(0, Math.max(0, budget - 1))}…`;
    stats.clipped += 1;
  }

  return { value, text, stats };
}

function json(value: unknown): string {
  return JSON.stringify(value) ?? "null";
}

function shrink(value: unknown, budget: number, stats: FitStats): unknown {
  const size = json(value).length;
  if (size <= budget) return value;

  if (typeof value === "string") {
    stats.clipped += 1;
    // Quotes and escapes cost characters too; aim a little under.
    const room = Math.max(0, budget - 3 - (size - value.length - 2));
    return `${value.slice(0, room)}…`;
  }

  if (Array.isArray(value)) return shrinkArray(value, budget, stats);

  if (typeof value === "object" && value !== null) {
    return shrinkObject(value as Record<string, unknown>, budget, stats);
  }

  return value;
}

function shrinkArray(items: readonly unknown[], budget: number, stats: FitStats): unknown[] {
  const sizes = items.map((item) => json(item).length);
  const available = budget - 2 - Math.max(0, items.length - 1);

  const cap = waterLevel(sizes, available);
  if (cap >= MIN_ITEM_SHARE) {
    const shared = items.map((item, i) => ((sizes[i] ?? 0) > cap ? shrink(item, cap, stats) : item));
    if (json(shared).length <= budget) return shared;
  }

  // Too many items to share the budget sensibly: keep the longest prefix.
  let used = 2;
  let kept = 0;
  for (const size of sizes) {
    const cost = size + (kept > 0 ? 1 : 0);
    if (used + cost > budget) break;
    used += cost;
    kept += 1;
  }

  if (kept === 0 && items.length > 0) {
    // Not even one whole item fits; keep a reduced first item rather than nothing.
    stats.omitted += items.length - 1;
    return [shrink(items[0], budget - 2, stats)];
  }

  stats.omitted += items.length - kept;
  return items.slice(0, kept);
}

function shrinkObject(
  source: Record<string, unknown>,
  budget: number,
  stats: FitStats,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...source };
  const keys = Object.keys(out);
  const sizes = keys.map((key) => json(out[key]).length);

  // Key names, quotes, colons and commas are fixed overhead.
  const overhead = json(Object.fromEntries(keys.map((key) => [key, 0]))).length - keys.length;
  const cap = waterLevel(sizes, budget - overhead);

  keys.forEach((key, i) => {
    if ((sizes[i] ?? 0) > cap) out[key] = shrink(out[key], Math.max(cap, 16), stats);
  });

  return out;
}

/**
 * The largest per-item cap `c` such that sum(min(size, c)) <= available.
 * Items under the cap keep everything; only the big ones are trimmed.
 */
function waterLevel(sizes: readonly number[], available: number): number {
  if (sizes.length === 0) return available;

  const sorted = [...sizes].sort((a, b) => a - b);
  let remaining = available;

  for (let i = 0; i < sorted.length; i++) {
    const share = Math.floor(remaining / (sorted.length - i));
    const size = sorted[i] ?? 0;
    if (size > share) return share;
    remaining -= size;
  }

  return Number.POSITIVE_INFINITY;
}

/** Human note describing what fitting removed, or undefined when nothing was. */
export function describeTrim(stats: FitStats): string | undefined {
  if (stats.omitted === 0 && stats.clipped === 0) return undefined;

  const parts: string[] = [];
  if (stats.omitted > 0) parts.push(`${stats.omitted} list item(s) omitted`);
  if (stats.clipped > 0) parts.push(`${stats.clipped} long value(s) clipped`);
  return (
    `[Output trimmed to fit the context budget: ${parts.join(", ")}. ` +
    "Use a smaller limit or a filter to see the rest.]"
  );
}
