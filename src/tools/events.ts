import { z } from "zod";
import { defineTool } from "./registry.js";
import type { ToolContext } from "./registry.js";
import { plural, resolveChannel } from "./util.js";
import { EVENT_TYPES } from "../discord/gateway.js";
import type { BufferedEvent } from "../discord/gateway.js";
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
  const author = filters.from_author?.trim().replace(/^@/, "").toLowerCase();

  return (event) => {
    if (types && !types.has(event.type)) return false;
    if (guildId !== undefined && event.guild_id !== guildId) return false;
    if (channels && (event.channel_id === undefined || !channels.has(event.channel_id))) return false;
    if (author !== undefined && event.user?.toLowerCase() !== author && event.user_id !== author) return false;
    if (needle !== undefined && !(event.content ?? event.summary).toLowerCase().includes(needle)) return false;
    return true;
  };
}

function present(event: BufferedEvent, includeRaw: boolean): Omit<BufferedEvent, "data" | "content"> | BufferedEvent {
  if (includeRaw) return event;
  const { data: _data, content: _content, ...rest } = event;
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
    const matcher = await buildMatcher(ctx, args);
    const event = await ctx.gateway.waitFor(matcher, args.timeout_seconds * 1000, {
      afterSeq: args.after_seq,
      signal: ctx.signal,
    });

    if (!event) {
      const why = ctx.signal.aborted ? "Cancelled" : `No matching event within ${args.timeout_seconds}s`;
      return {
        summary: `${why}. Filters: ${args.types.join(", ")}.`,
        data: { timed_out: true, last_seq: ctx.gateway.lastSeq },
      };
    }

    return {
      summary: `${event.type}: ${event.summary}`,
      data: { ...present(event, args.include_raw), last_seq: event.seq },
    };
  },
});

export const recentEvents = defineTool({
  name: "discord_recent_events",
  title: "Read buffered live events",
  description:
    "Returns events buffered since the gateway connected, without waiting.\n\n" +
    "The buffer fills only while connected - from the first call to this tool or discord_wait_for_event " +
    "until an idle period passes. Pass after_seq (the last_seq from the previous call) to get only new " +
    "events. For older history use discord_read_messages.",
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

    const since = ctx.gateway.listeningSince;
    return {
      summary:
        `${plural(buffered.length, "buffered event")}` +
        (since ? ` since the gateway connected at ${since}` : "") +
        `. last_seq=${ctx.gateway.lastSeq}.`,
      data: { events: buffered.map((e) => present(e, args.include_raw)), last_seq: ctx.gateway.lastSeq },
    };
  },
});
