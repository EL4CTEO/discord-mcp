import { z } from "zod";
import { defineTool, errorText, MAX_BULK } from "./registry.js";
import type { Outcome } from "./registry.js";
import { plural } from "./util.js";
import { mapLanes } from "../lib/limiter.js";
import type { Settled } from "../lib/limiter.js";
import { ToolError } from "../lib/errors.js";

export const batch = defineTool({
  name: "discord_batch",
  title: "Run several Discord tools in parallel",
  description:
    "Runs several different Discord tool calls in one request, in parallel within Discord's rate limits.\n\n" +
    "Each operation is {tool, args} with exactly the arguments that tool takes directly. `defaults` fills " +
    "arguments an operation leaves out (e.g. {guild: 'my server'}), wherever the tool accepts them. For the " +
    "same tool over many targets, prefer passing an array to that tool instead.\n\n" +
    "One failure does not stop the others - each operation reports ok/error - unless stop_on_error is set.\n\n" +
    'Example: operations: [{"tool":"discord_send_message","args":{"channel":"general","content":"Deploy done"}},' +
    ' {"tool":"discord_manage_member_roles","args":{"member":"alice","add":["Release"]}}]',
  inputSchema: {
    operations: z
      .array(
        z.object({
          tool: z.string().min(1).describe("Name of the tool to run, e.g. 'discord_send_message'."),
          args: z.record(z.string(), z.unknown()).default({}).describe("Arguments for that tool."),
        }),
      )
      .min(1)
      .max(MAX_BULK)
      .describe(`Up to ${MAX_BULK} operations.`),
    defaults: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Arguments applied to every operation that accepts them and does not set them itself."),
    concurrency: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .describe("How many operations run at once. Defaults to DISCORD_BATCH_CONCURRENCY (4)."),
    stop_on_error: z
      .boolean()
      .default(false)
      .describe("Abandon operations that have not started once one fails. In-flight work still completes."),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  async handler(args, ctx) {
    if (args.operations.some((op) => op.tool === "discord_batch")) {
      throw new ToolError("discord_batch cannot contain another discord_batch.", {
        code: "NESTED_BATCH",
        hint: "Flatten the operations into a single list.",
      });
    }

    const operations = args.operations.map((op) => ({
      tool: op.tool,
      args: withDefaults(op.args, args.defaults, ctx.accepts(op.tool)),
    }));

    // Group by the rate-limit bucket each operation will land in, so the
    // scheduler parallelises across buckets and stays sequential within one.
    const lanes = new Map<string, Array<{ index: number; tool: string; args: Record<string, unknown> }>>();
    operations.forEach((op, index) => {
      const key = bucketKey(op.tool, op.args);
      const entry = { index, ...op };
      const lane = lanes.get(key);
      if (lane) lane.push(entry);
      else lanes.set(key, [entry]);
    });

    let done = 0;
    const laneList = [...lanes.values()];
    const laneResults = await mapLanes(
      laneList,
      args.concurrency ?? ctx.config.batchConcurrency,
      // Routing through ctx.invoke means every operation takes the same
      // validation, destructive-gate and error-normalisation path as a direct
      // call - there is no second implementation to keep in sync.
      async (entry) => {
        try {
          return await ctx.invoke(entry.tool, entry.args);
        } finally {
          ctx.progress(++done, operations.length, entry.tool);
        }
      },
      { stopOnError: args.stop_on_error, signal: ctx.signal },
    );

    // Flatten back into the caller's order, which lanes deliberately scrambled.
    const results = new Array<Settled<Outcome>>(operations.length);
    laneList.forEach((lane, laneIndex) => {
      (laneResults[laneIndex] ?? []).forEach((settled, position) => {
        const index = lane[position]?.index;
        if (index !== undefined) results[index] = { ...settled, index };
      });
    });

    const data = Array.from(results, (result, index) => {
      const tool = operations[index]?.tool;
      if (result?.ok) return { index, tool, ok: true as const, summary: result.value.summary, data: result.value.data };
      return { index, tool, ok: false as const, error: result ? errorText(result.error) : "Not run." };
    });

    const succeeded = data.filter((d) => d.ok).length;
    const failed = data.length - succeeded;

    return {
      summary:
        `Batch finished: ${succeeded}/${data.length} succeeded` + (failed > 0 ? `, ${plural(failed, "failure")}.` : "."),
      data,
    };
  },
});

/** Merges batch-level defaults into one operation's args, only for keys that tool accepts. */
function withDefaults(
  args: Record<string, unknown>,
  defaults: Record<string, unknown> | undefined,
  accepts: (key: string) => boolean,
): Record<string, unknown> {
  if (!defaults) return args;
  const merged = { ...args };
  for (const [key, value] of Object.entries(defaults)) {
    if (merged[key] === undefined && accepts(key)) merged[key] = value;
  }
  return merged;
}

/**
 * Approximates the Discord rate-limit bucket an operation will use.
 *
 * Discord keys its buckets on route + method + "major parameter" (the channel
 * or guild id). Two calls to the same tool against the same channel share a
 * bucket; different tools, or the same tool against different channels, do not.
 */
function bucketKey(tool: string, args: Record<string, unknown>): string {
  const major =
    (typeof args["channel"] === "string" && args["channel"]) ||
    (typeof args["guild"] === "string" && args["guild"]) ||
    "";
  return `${tool}|${major}`;
}
