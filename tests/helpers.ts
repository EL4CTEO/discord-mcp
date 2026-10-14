import { vi } from "vitest";
import type { Config } from "../src/config.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { AnyTool } from "../src/tools/registry.js";

export const config = (overrides: Partial<Config> = {}): Config => ({
  token: "t",
  defaultGuild: undefined,
  allowDestructive: false,
  privilegedIntents: true,
  requestTimeoutMs: 15000,
  maxResponseChars: 25000,
  gatewayIdleMs: 120000,
  eventBufferSize: 200,
  batchConcurrency: 4,
  uploadDirs: undefined,
  allowMassMentions: false,
  ...overrides,
});

/** Records every REST call; `routes` answers GETs by route substring. */
export function fakeRest(routes: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; route: string; body?: unknown }> = [];
  const answer = (route: string): unknown => {
    const match = Object.entries(routes).find(([key]) => route.includes(key));
    return match?.[1];
  };
  const record = (method: string) =>
    vi.fn(async (route: string, body?: unknown) => {
      calls.push({ method, route: decodeURIComponent(route), body });
      const value = answer(decodeURIComponent(route));
      if (value instanceof Error) throw value;
      return typeof value === "function" ? (value as (b: unknown) => unknown)(body) : value;
    });

  const rest = {
    get: vi.fn(async (route: string) => {
      calls.push({ method: "GET", route: decodeURIComponent(route) });
      const value = answer(decodeURIComponent(route));
      if (value === undefined) throw new Error(`unexpected route ${route}`);
      if (value instanceof Error) throw value;
      return value;
    }),
    post: record("POST"),
    patch: record("PATCH"),
    put: record("PUT"),
    delete: vi.fn(async (route: string) => {
      calls.push({ method: "DELETE", route: decodeURIComponent(route) });
      const value = answer(`DELETE ${decodeURIComponent(route)}`);
      if (value instanceof Error) throw value;
      return value;
    }),
  };
  return { rest, calls };
}

export function registryWith(
  tools: readonly AnyTool[],
  parts: { rest?: unknown; resolver?: unknown; gateway?: unknown; config?: Config } = {},
): ToolRegistry {
  return new ToolRegistry({
    config: parts.config ?? config(),
    rest: (parts.rest ?? {}) as never,
    resolver: (parts.resolver ?? {}) as never,
    gateway: (parts.gateway ?? {}) as never,
  }).add(...tools);
}

/** Snowflake for a message created `ageMs` ago. */
export function snowflakeAged(ageMs: number): string {
  return ((BigInt(Date.now() - ageMs) - 1_420_070_400_000n) << 22n).toString();
}
