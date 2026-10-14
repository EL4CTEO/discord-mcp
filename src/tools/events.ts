import { z } from "zod";
import { defineTool } from "./registry.js";
import type { ToolContext } from "./registry.js";
import { plural, resolveChannel } from "./util.js";
import { EVENT_TYPES } from "../discord/gateway.js";
import type { BufferedEvent, WaitOutcome } from "../discord/gateway.js";
import { channelRef, guildRef } from "../schemas/common.js";

const channelsFilter = z
  .union([channelRef, z.array(channelRef).min(1).max(25)])
  .optional()
  .describe("Only events in this channel, or in any of these channels.");

const afterSeq = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe("Only events newer than this seq (from a previous result's last_seq), so nothing is seen twice or missed.");

const PRIVILEGED_NOTE =
  "Message content and member events are unavailable: enable MESSAGE CONTENT and SERVER MEMBERS intents in the Developer Portal.";

/** Appends the privileged-intent warning whenever those events cannot arrive. */
function withNotes(summary: string, ctx: ToolContext): string {
  return ctx.gateway.privilegedAvailable ? summary : `${summary} ${PRIVILEGED_NOTE}`;
}

interface Filters {
  types?: readonly string[] | undefined;
  guild?: string | undefined;
  channel?: string | readonly string[] | undefined;
  contains?: string | undefined;
  from_author?: string | undefined;
}

/** Builds one predicate from every filter, resolving names to IDs up front. */
async function buildMatcher(ctx: ToolContext, filters: Filters): Promise<(event: BufferedEvent) => boolean> {
  const channelInputs =
    filters.channel === undefined ? [] : typeof filters.channel === "string" ? [filters.channel] : filters.channel;

  const [guildId, channelIds] = await Promise.all([
    filters.guild ? ctx.resolver.guildId(filters.guild) : undefined,
    Promise.all(channelInputs.map((c) => resolveChannel(ctx, c, filters.guild))),
  ]);

  const types = filters.types?.length ? new Set(filters.types) : undefined;
  const channels = channelIds.length > 0 ? new Set(channelIds) : undefined;
  const needle = filters.contains?.toLowerCase();
  // "@" alone would strip to "" and silently match nothing, so it counts as no filter.
  const author = filters.from_author?.trim().replace(/^@/, "").toLowerCase() || undefined;

  return (event) => {
    if (types && !types.has(event.type)) return false;
    if (guildId !== undefined && event.guild_id !== guildId) return false;
    if (channels && (event.channel_id === undefined || !channels.has(event.channel_id))) return false;
    if (author !== undefined && event.user?.toLowerCase() !== author && event.user_id !== author) return false;
    if (needle !== undefined && !(event.content ?? event.summary).toLowerCase().includes(needle)) return false;
    return true;
  };
}

/** Drops the full raw payload unless asked for it. Message text stays: it is what an agent acts on. */
function present(event: BufferedEvent, includeRaw: boolean): Omit<BufferedEvent, "data"> | BufferedEvent {
  if (includeRaw) return event;
  const { data: _data, ...rest } = event;
  return rest;
}

export const waitForEvent = defineTool({
  name: "discord_wait_for_event",
  title: "Wait for a live Discord event",
  description:
    "Blocks until a matching live event arrives, or the timeout expires - a reply in a channel, someone " +
    "joining, a reaction.\n\n" +
    "The first call opens a gateway connection (a few seconds); later calls reuse it. Pass after_seq from a " +
    "previous discord_recent_events result to also catch anything that arrived in between. Keep " +
    "timeout_seconds modest - the call is held open for its whole duration.",
  inputSchema: {
    types: z.array(z.enum(EVENT_TYPES)).min(1).describe("Event types to wait for, e.g. ['MESSAGE_CREATE']."),
    guild: guildRef.optional().describe("Only match events from this server."),
    channel: channelsFilter,
    contains: z.string().min(1).optional().describe("For message events: only match if the text contains this."),
    from_author: z.string().min(1).optional().describe("Only events caused by this username or user ID."),
    timeout_seconds: z.number().int().min(1).max(600).default(60),
    after_seq: afterSeq,
    include_raw: z.boolean().default(false).describe("Include the full raw gateway payload. Verbose."),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async handler(args, ctx) {
    // Read the cursor before name resolution, which can take a while: an event
    // arriving during it must still count as "after" the caller's last look.
    const since = args.after_seq ?? ctx.gateway.lastSeq;
    const matcher = await buildMatcher(ctx, args);
    const result = await ctx.gateway.waitFor(matcher, args.timeout_seconds * 1000, {
      afterSeq: since,
      signal: ctx.signal,
    });

    if (result.reason === "matched") {
      const { event } = result;
      return {
        summary: withNotes(`${event.type}: ${JSON.stringify(event.summary)}`, ctx),
        data: { ...present(event, args.include_raw), last_seq: event.seq },
      };
    }

    const filters = `Filters: ${args.types.join(", ")}.`;
    const why = describeStop(result.reason, args.timeout_seconds, ctx.gateway.lastError);
    return {
      summary: withNotes(`${why}. ${filters}`, ctx),
      data: { timed_out: result.reason === "timeout", reason: result.reason, last_seq: ctx.gateway.lastSeq },
    };
  },
});

/** Human sentence for a wait that ended without a match. */
function describeStop(
  reason: Exclude<WaitOutcome, "matched">,
  timeoutSeconds: number,
  lastError: string | undefined,
): string {
  switch (reason) {
    case "timeout":
      return `No matching event within ${timeoutSeconds}s`;
    case "cancelled":
      return "Cancelled";
    case "closed":
      return lastError
        ? `The gateway connection closed: ${lastError.replace(/\.$/, "")}`
        : "The gateway connection closed";
  }
}

export const recentEvents = defineTool({
  name: "discord_recent_events",
  title: "Read buffered live events",
  description:
    "Returns events buffered since the gateway connected, without waiting.\n\n" +
    "The buffer fills only while connected - from the first call to this tool or discord_wait_for_event " +
    "until an idle period passes. Pass after_seq (the last_seq from the previous call) to get only new " +
    "events, oldest first, so repeated calls page through everything. For older history use " +
    "discord_read_messages.",
  inputSchema: {
    types: z.array(z.enum(EVENT_TYPES)).optional().describe("Filter to these event types."),
    guild: guildRef.optional(),
    channel: channelsFilter,
    from_author: z.string().min(1).optional().describe("Only events caused by this username or user ID."),
    after_seq: afterSeq,
    limit: z.number().int().min(1).max(200).default(50),
    include_raw: z.boolean().default(false).describe("Include the full raw gateway payload. Verbose."),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async handler(args, ctx) {
    const [matcher] = await Promise.all([buildMatcher(ctx, args), ctx.gateway.ensureConnected()]);
    const buffered = ctx.gateway.recent({ match: matcher, afterSeq: args.after_seq, limit: args.limit });

    // A full page with a cursor may hide newer matches, so the cursor moves to the
    // page's last event and the caller pages forward without gaps. Otherwise the
    // global sequence is safe: nothing matching was left out.
    const pageEnd =
      args.after_seq !== undefined && buffered.length === args.limit ? buffered[buffered.length - 1] : undefined;
    const lastSeq = pageEnd?.seq ?? ctx.gateway.lastSeq;

    const since = ctx.gateway.listeningSince;
    const more = pageEnd ? ` More events are buffered: call again with after_seq=${lastSeq}.` : "";
    // The ring buffer evicts its oldest events, so a stale cursor can skip some unnoticed.
    const oldest = ctx.gateway.oldestSeq;
    const gap = args.after_seq !== undefined && oldest !== undefined && oldest > args.after_seq + 1;
    const gapNote = gap ? ` Some events after seq ${args.after_seq} were already dropped from the buffer.` : "";
    return {
      summary: withNotes(
        `${plural(buffered.length, "buffered event")}` +
          (since ? ` since the gateway connected at ${since}` : "") +
          `. last_seq=${lastSeq}.` +
          more +
          gapNote,
        ctx,
      ),
      data: {
        events: buffered.map((e) => present(e, args.include_raw)),
        last_seq: lastSeq,
        ...(gap ? { gap: true } : {}),
      },
    };
  },
});
