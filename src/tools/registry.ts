import { z } from "zod";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "../config.js";
import type { DiscordRest } from "../discord/rest.js";
import type { Resolver } from "../discord/resolve.js";
import type { GatewayBridge } from "../discord/gateway.js";
import { destructiveDisabled, normalizeError, ToolError } from "../lib/errors.js";
import { mapLanes } from "../lib/limiter.js";
import { describeTrim, fitToBudget } from "../lib/render.js";

/** Most items one call may fan out over. */
export const MAX_BULK = 50;

/** Reports progress of a long-running call to the client, when it asked for it. */
export type ProgressReporter = (done: number, total: number, message?: string) => void;

/** Long-lived services shared by every call. */
export interface Services {
  readonly config: Config;
  readonly rest: DiscordRest;
  readonly resolver: Resolver;
  readonly gateway: GatewayBridge;
}

/** Per-call options supplied by the transport. */
export interface RunOptions {
  readonly signal?: AbortSignal;
  readonly progress?: ProgressReporter;
}

/** Everything a tool handler is allowed to touch. */
export interface ToolContext extends Services {
  /** Fires when the client cancels the call. Long waits and batches honour it. */
  readonly signal: AbortSignal;
  readonly progress: ProgressReporter;
  /** Runs another registered tool by name. Used by discord_batch. */
  invoke(name: string, args: unknown): Promise<Outcome>;
  /** Whether a registered tool takes the named argument. Used for batch defaults. */
  accepts(tool: string): (key: string) => boolean;
}

/**
 * What a handler returns: a one-line human summary plus optional structured
 * data. Keeping these separate lets the registry decide how to render and
 * truncate, so no tool has to think about the context budget itself.
 */
export interface Outcome {
  readonly summary: string;
  readonly data?: unknown;
}

export type Shape = z.ZodRawShape;

/** Per-item result of a fan-out, in the caller's order. */
export interface BulkItem {
  readonly value: unknown;
  readonly ok: boolean;
  readonly summary?: string;
  readonly data?: unknown;
  readonly error?: string;
}

export interface ToolDefinition<S extends Shape = Shape> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: S;
  readonly annotations?: Omit<ToolAnnotations, "title">;
  /** Gated behind DISCORD_ALLOW_DESTRUCTIVE, and hidden from clients while it is off. */
  readonly destructive?: boolean;
  /**
   * Arguments that may also be given as an array, turning any single call into
   * a bulk one. At most one of them may be an array in a given call.
   *
   * Widening the schema and fanning out happens centrally in ToolRegistry, so a
   * tool handler only ever deals with one value and no tool reimplements
   * looping, concurrency or partial-failure reporting.
   */
  readonly bulkArgs?: readonly string[];
  /**
   * Optional fast path for an array call, for tools where Discord offers a
   * real bulk endpoint (bulk ban, bulk message delete). Returns undefined to
   * fall back to the generic per-item fan-out.
   */
  readonly bulkHandler?: (
    args: z.infer<z.ZodObject<S>>,
    bulkArg: string,
    values: readonly string[],
    ctx: ToolContext,
  ) => Promise<BulkItem[] | undefined>;
  /**
   * Replaces the generic hint when Discord answers 50013 (Missing Permissions).
   * The generic advice cannot name the permission involved, and Discord keeps
   * splitting capabilities into new bits - Pin Messages stopped being covered
   * by Manage Messages - so naming it per tool is the only accurate option.
   */
  readonly missingPermissionHint?: string;
  readonly handler: (args: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<Outcome>;
}

/**
 * A tool with its argument type erased, for storing heterogeneous tools together.
 *
 * The handlers take `never` deliberately: parameter contravariance makes every
 * concrete ToolDefinition<S> assignable to this, while still refusing to be
 * called without a validated argument. That keeps the registry free of `any`.
 */
export interface AnyTool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Shape;
  readonly annotations?: Omit<ToolAnnotations, "title">;
  readonly destructive?: boolean;
  readonly missingPermissionHint?: string;
  readonly bulkArgs?: readonly string[];
  readonly bulkHandler?: (
    args: never,
    bulkArg: string,
    values: readonly string[],
    ctx: ToolContext,
  ) => Promise<BulkItem[] | undefined>;
  readonly handler: (args: never, ctx: ToolContext) => Promise<Outcome>;
}

const schemaCache = new WeakMap<AnyTool, Shape>();

/**
 * The schema advertised to clients: the tool's own shape, except that its bulk
 * arguments also accept an array.
 *
 * Doing this centrally is what makes "every tool supports bulk" true without
 * 30 tools each growing their own array handling, concurrency and
 * partial-failure reporting. Memoised, because it runs on every call.
 */
export function effectiveSchema(definition: AnyTool): Shape {
  const cached = schemaCache.get(definition);
  if (cached) return cached;

  const shape = { ...definition.inputSchema } as Record<string, z.ZodType>;
  for (const arg of definition.bulkArgs ?? []) {
    const original = shape[arg];
    if (original === undefined) continue;

    const description = original.description;
    const optional = original instanceof z.ZodOptional;
    const inner = withoutMetadata(optional ? (original as z.ZodOptional<z.ZodType>).unwrap() : original);
    const note = `Accepts an array to act on up to ${MAX_BULK} at once, in parallel, with per-item results.`;

    const widened = z.union([inner, z.array(inner).min(1).max(MAX_BULK)]);
    shape[arg] = (optional ? widened.optional() : widened).describe(
      description === undefined ? note : `${description} ${note}`,
    );
  }

  schemaCache.set(definition, shape);
  return shape;
}

/**
 * The same validator with no description attached, so a widened argument
 * documents itself once, on the union, instead of on the union and on both of
 * its branches. clone() is not enough: zod carries metadata over from the
 * schema it was cloned from. Rebuilding from the definition keeps every check.
 */
function withoutMetadata(schema: z.ZodType): z.ZodType {
  const Schema = schema.constructor as new (def: unknown) => z.ZodType;
  return new Schema({ ...schema._zod.def });
}

/** Identity helper that preserves the generic shape for inference. */
export function defineTool<S extends Shape>(definition: ToolDefinition<S>): ToolDefinition<S> {
  return definition;
}

/**
 * Renders an outcome into an MCP tool result.
 *
 * JSON is emitted compact: indentation is pure token cost to a model. Large
 * payloads are shrunk rather than cut off (see fitToBudget), and the result
 * says what was removed so the agent can narrow its query instead of
 * silently reasoning over partial data.
 */
export function renderOutcome(outcome: Outcome, maxChars: number): CallToolResult {
  if (outcome.data === undefined) {
    return { content: [{ type: "text", text: outcome.summary }] };
  }

  const fitted = fitToBudget(outcome.data, maxChars - outcome.summary.length - 160);
  const notice = describeTrim(fitted.stats);

  return {
    content: [{ type: "text", text: `${outcome.summary}\n${fitted.text}${notice ? `\n${notice}` : ""}` }],
    structuredContent: isPlainObject(fitted.value) ? fitted.value : { result: fitted.value },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Renders a failure as an MCP error result rather than throwing over the wire. */
export function renderError(error: unknown, context: string): CallToolResult {
  const toolError = error instanceof ToolError ? error : normalizeError(error, context);
  return { content: [{ type: "text", text: toolError.toText() }], isError: true };
}

/** Error text for a per-item failure report. */
export function errorText(error: unknown): string {
  return error instanceof ToolError ? error.toText() : error instanceof Error ? error.message : String(error);
}

const NEVER_ABORTED = new AbortController().signal;
const NO_PROGRESS: ProgressReporter = () => undefined;

/**
 * Holds every registered tool and runs them.
 *
 * Centralising execution here means the destructive gate, the error
 * normalisation and the batch dispatcher all share one code path - a tool
 * invoked through discord_batch behaves exactly like a direct call.
 */
export class ToolRegistry {
  readonly #tools = new Map<string, AnyTool>();
  readonly #validators = new Map<string, z.ZodType>();
  readonly #services: Services;

  constructor(services: Services) {
    this.#services = services;
  }

  add(...definitions: readonly AnyTool[]): this {
    for (const definition of definitions) {
      if (this.#tools.has(definition.name)) {
        throw new Error(`Duplicate tool name: ${definition.name}`);
      }
      this.#tools.set(definition.name, definition);
    }
    return this;
  }

  get(name: string): AnyTool | undefined {
    return this.#tools.get(name);
  }

  list(): AnyTool[] {
    return [...this.#tools.values()];
  }

  get names(): string[] {
    return [...this.#tools.keys()];
  }

  /** Full execution path: gate, validate, run, normalise errors. */
  async run(name: string, args: unknown, options: RunOptions = {}): Promise<Outcome> {
    const definition = this.#tools.get(name);
    if (!definition) {
      throw new ToolError(`Unknown tool "${name}".`, {
        code: "UNKNOWN_TOOL",
        hint: `Available tools: ${this.names.join(", ")}`,
      });
    }

    if (definition.destructive === true && !this.#services.config.allowDestructive) {
      throw destructiveDisabled(name);
    }

    const parsed = this.#parse(definition, args);
    const ctx = this.#context(options);

    const arrays = (definition.bulkArgs ?? []).filter((arg) => Array.isArray(parsed[arg]));
    if (arrays.length > 1) {
      throw new ToolError(`Only one of ${arrays.join(", ")} may be an array in a single call.`, {
        code: "INVALID_ARGS",
        hint: "Split the call, or use discord_batch to combine different fan-outs.",
      });
    }

    const [bulkArg] = arrays;
    if (bulkArg !== undefined) {
      return this.#runBulk(definition, parsed, bulkArg, parsed[bulkArg] as unknown[], ctx);
    }

    return this.#runOne(definition, parsed, ctx);
  }

  #context(options: RunOptions): ToolContext {
    const signal = options.signal ?? NEVER_ABORTED;
    return {
      ...this.#services,
      signal,
      progress: options.progress ?? NO_PROGRESS,
      // Nested calls share cancellation but report no progress of their own;
      // the batch reports progress across all of them instead.
      invoke: (name, args) => this.run(name, args, { signal }),
      accepts: (tool) => {
        const shape = this.#tools.get(tool)?.inputSchema;
        return (key) => shape !== undefined && Object.hasOwn(shape, key);
      },
    };
  }

  async #runOne(definition: AnyTool, args: unknown, ctx: ToolContext): Promise<Outcome> {
    try {
      return await definition.handler(args as never, ctx);
    } catch (error) {
      throw this.#normalize(definition, error);
    }
  }

  #normalize(definition: AnyTool, error: unknown): ToolError {
    const normalized = normalizeError(error, definition.title.toLowerCase());

    if (normalized.code === 50013 && definition.missingPermissionHint) {
      return new ToolError(normalized.message, {
        code: normalized.code,
        hint: definition.missingPermissionHint,
        cause: error,
      });
    }

    return normalized;
  }

  /**
   * Fans one call out over an array bulk argument.
   *
   * A tool's own bulkHandler gets the first chance, for endpoints Discord
   * offers in bulk. Otherwise items are grouped so repeats of one value run in
   * sequence while distinct values run together - the same scheduling
   * discord_batch uses. One failure never hides the successes: each item
   * reports its own result.
   */
  async #runBulk(
    definition: AnyTool,
    args: Record<string, unknown>,
    bulkArg: string,
    values: readonly unknown[],
    ctx: ToolContext,
  ): Promise<Outcome> {
    let items: BulkItem[] | undefined;

    if (definition.bulkHandler && values.every((v): v is string => typeof v === "string")) {
      try {
        items = await definition.bulkHandler(args as never, bulkArg, values, ctx);
      } catch (error) {
        throw this.#normalize(definition, error);
      }
    }

    items ??= await this.#fanOut(definition, args, bulkArg, values, ctx);

    const data = items.map((item) => ({
      [bulkArg]: item.value,
      ok: item.ok,
      ...(item.ok ? { summary: item.summary, data: item.data } : { error: item.error }),
    }));

    const succeeded = items.filter((item) => item.ok).length;
    const failed = items.length - succeeded;

    return {
      summary:
        `${definition.name} on ${items.length} items: ${succeeded} succeeded` +
        (failed > 0 ? `, ${failed} failed.` : "."),
      data,
    };
  }

  async #fanOut(
    definition: AnyTool,
    args: Record<string, unknown>,
    bulkArg: string,
    values: readonly unknown[],
    ctx: ToolContext,
  ): Promise<BulkItem[]> {
    const lanes = new Map<string, Array<{ index: number; value: unknown }>>();
    values.forEach((value, index) => {
      const key = typeof value === "string" ? value : String(index);
      const lane = lanes.get(key);
      if (lane) lane.push({ index, value });
      else lanes.set(key, [{ index, value }]);
    });

    let done = 0;
    const laneList = [...lanes.values()];
    const laneResults = await mapLanes(
      laneList,
      ctx.config.batchConcurrency,
      async (entry) => {
        try {
          return await this.#runOne(definition, { ...args, [bulkArg]: entry.value }, ctx);
        } finally {
          ctx.progress(++done, values.length);
        }
      },
      { signal: ctx.signal },
    );

    const items = new Array<BulkItem>(values.length);
    laneList.forEach((lane, laneIndex) => {
      (laneResults[laneIndex] ?? []).forEach((settled, position) => {
        const entry = lane[position];
        if (!entry) return;
        items[entry.index] = settled.ok
          ? { value: entry.value, ok: true, summary: settled.value.summary, data: settled.value.data }
          : { value: entry.value, ok: false, error: errorText(settled.error) };
      });
    });

    return Array.from(items, (item, index) => item ?? { value: values[index], ok: false, error: "Not run." });
  }

  /**
   * Validates arguments.
   *
   * Direct MCP calls are already validated by the SDK against the same schema,
   * so this matters most for discord_batch, where operations arrive as opaque
   * JSON. Errors are reshaped into the same actionable style as API failures.
   */
  #parse(definition: AnyTool, args: unknown): Record<string, unknown> {
    let schema = this.#validators.get(definition.name);
    if (!schema) {
      schema = z.object(effectiveSchema(definition)).strict();
      this.#validators.set(definition.name, schema);
    }

    const result = schema.safeParse(args ?? {});
    if (!result.success) {
      const issues = result.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ");
      throw new ToolError(`Invalid arguments for ${definition.name}: ${issues}`, {
        code: "INVALID_ARGS",
        hint: `Expected fields: ${Object.keys(definition.inputSchema).join(", ")}`,
      });
    }

    return result.data as Record<string, unknown>;
  }
}
