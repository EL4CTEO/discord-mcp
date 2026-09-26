import { REST, makeURLSearchParams } from "@discordjs/rest";
import type { RawFile, RouteLike } from "@discordjs/rest";
import type { Config } from "../config.js";
import { VERSION } from "../version.js";

export type QueryParams = Record<string, string | number | boolean | undefined>;

/**
 * Thin typed facade over @discordjs/rest.
 *
 * The underlying client already queues per-route rate-limit buckets and honours
 * the global limit, so nothing here needs to re-implement backoff. What it adds
 * is generics (the raw client returns `unknown`), query-string handling and
 * GET de-duplication, so tool code stays free of casts.
 */
export class DiscordRest {
  readonly #rest: REST;
  readonly #inFlightGets = new Map<string, Promise<unknown>>();

  constructor(config: Config) {
    this.#rest = new REST({
      version: "10",
      timeout: config.requestTimeoutMs,
      retries: 2,
      userAgentAppendix: `discord-mcp/${VERSION}`,
    }).setToken(config.token);
  }

  /** The raw client, shared with the gateway so both use one rate-limit state. */
  get raw(): REST {
    return this.#rest;
  }

  /**
   * GET with in-flight de-duplication.
   *
   * Identical GETs issued while one is still in the air share that response
   * instead of queueing a second request behind it in the same rate-limit
   * bucket. This is de-duplication, not caching: nothing is retained after the
   * request settles, so a later read still sees fresh data. Callers must treat
   * the result as read-only, since concurrent callers share the object.
   */
  async get<T>(route: RouteLike, query?: QueryParams): Promise<T> {
    const params = query ? makeURLSearchParams(stripUndefined(query)) : undefined;
    const key = `${route}?${params?.toString() ?? ""}`;

    const inFlight = this.#inFlightGets.get(key);
    if (inFlight) return inFlight as Promise<T>;

    const request = (this.#rest.get(route, { query: params }) as Promise<T>).finally(() => {
      this.#inFlightGets.delete(key);
    });

    this.#inFlightGets.set(key, request as Promise<unknown>);
    return request;
  }

  /** POST; when `files` are given the body is sent as multipart payload_json. */
  async post<T>(route: RouteLike, body?: unknown, reason?: string, files?: RawFile[]): Promise<T> {
    return (await this.#rest.post(route, { body, reason, files })) as T;
  }

  async patch<T>(route: RouteLike, body?: unknown, reason?: string): Promise<T> {
    return (await this.#rest.patch(route, { body, reason })) as T;
  }

  async put<T>(route: RouteLike, body?: unknown, reason?: string): Promise<T> {
    return (await this.#rest.put(route, { body, reason })) as T;
  }

  async delete<T = void>(route: RouteLike, reason?: string, body?: unknown): Promise<T> {
    return (await this.#rest.delete(route, { reason, body })) as T;
  }
}

/** Discord rejects explicit nulls in query strings; drop unset keys entirely. */
function stripUndefined(query: QueryParams): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}
