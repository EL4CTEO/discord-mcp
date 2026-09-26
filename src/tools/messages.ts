import { basename } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { ChannelType, MessageFlags, Routes } from "discord-api-types/v10";
import type { APIMessage, APIUser, RESTGetAPIChannelMessagesPinsResult } from "discord-api-types/v10";
import type { RawFile } from "@discordjs/rest";
import { defineTool, errorText } from "./registry.js";
import type { BulkItem, ToolContext } from "./registry.js";
import {
  compareSnowflakes,
  fetchHistory,
  guildForChannel,
  plural,
  resolveChannel,
  resolveEmoji,
} from "./util.js";
import { formatMessage, formatUser, searchableText, snowflakeMs } from "../lib/format.js";
import type { CompactMessage } from "../lib/format.js";
import { ToolError } from "../lib/errors.js";
import { mapWithConcurrency } from "../lib/limiter.js";
import { MESSAGE_LIMIT, splitMessage } from "../lib/text.js";
import { isSnowflake } from "../discord/resolve.js";
import {
  allowMentions,
  channelRef,
  detail,
  embedSchema,
  guildRef,
  memberRef,
  mentionPolicy,
  messageId,
  toApiEmbed,
} from "../schemas/common.js";
import type { EmbedInput } from "../schemas/common.js";

/** Channel types that actually hold readable message history. */
const TEXTUAL_TYPES = new Set<ChannelType>([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  ChannelType.AnnouncementThread,
  ChannelType.GuildVoice,
]);

/** Discord refuses bulk deletes of anything older than this. */
export const BULK_DELETE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** Leeway so a message that ages past 14 days mid-request is not sent to the bulk route. */
const BULK_DELETE_MARGIN_MS = 60_000;

/** Sanity cap on one upload; Discord enforces the real (boost-dependent) limit. */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/** Long text is split into at most this many messages. */
const MAX_PARTS = 10;

const fileSchema = z
  .object({
    path: z.string().min(1).optional().describe("Local file path to upload."),
    url: z.url().optional().describe("http(s) URL to download and re-upload."),
    name: z.string().min(1).max(200).optional().describe("File name shown in Discord. Defaults to the source name."),
    spoiler: z.boolean().optional().describe("Blur the attachment until clicked."),
  })
  .refine((f) => (f.path === undefined) !== (f.url === undefined), "Give exactly one of path or url.");

type FileInput = z.infer<typeof fileSchema>;

const pollSchema = z
  .object({
    question: z.string().min(1).max(300),
    answers: z.array(z.string().min(1).max(55)).min(1).max(10),
    duration_hours: z.number().int().min(1).max(768).default(24),
    multiselect: z.boolean().default(false),
  })
  .describe("Attach a native Discord poll.");

type PollInput = z.infer<typeof pollSchema>;

/** Everything needed to post one logical message, possibly as several parts. */
interface PostInput {
  content?: string | undefined;
  embeds?: EmbedInput[] | undefined;
  files?: FileInput[] | undefined;
  poll?: PollInput | undefined;
  reply_to?: string | undefined;
  allow_mentions: boolean;
  silent: boolean;
  suppress_embeds?: boolean | undefined;
}

const postShape = {
  content: z
    .string()
    .max(MESSAGE_LIMIT * MAX_PARTS)
    .optional()
    .describe(
      `Message text. Over ${MESSAGE_LIMIT} characters it is split into several messages at paragraph/line ` +
        "boundaries, keeping code blocks intact.",
    ),
  embeds: z.array(embedSchema).max(10).optional().describe("Up to 10 rich embeds."),
  files: z.array(fileSchema).max(10).optional().describe("Up to 10 attachments, from local paths or URLs."),
  poll: pollSchema.optional(),
  allow_mentions: allowMentions,
  silent: z.boolean().default(false).describe("Send without triggering a push notification."),
  suppress_embeds: z.boolean().optional().describe("Hide link previews."),
};

async function loadFile(file: FileInput): Promise<RawFile> {
  let data: Buffer;
  let name: string;

  if (file.path !== undefined) {
    const info = await stat(file.path).catch(() => undefined);
    if (!info?.isFile()) {
      throw new ToolError(`No file at "${file.path}".`, { code: "FILE_NOT_FOUND", hint: "Pass an absolute path." });
    }
    if (info.size > MAX_UPLOAD_BYTES) {
      throw new ToolError(`"${file.path}" is too large to upload (${Math.round(info.size / 1048576)} MB).`, {
        code: "FILE_TOO_LARGE",
      });
    }
    data = await readFile(file.path);
    name = basename(file.path);
  } else {
    const url = file.url as string;
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) {
      throw new ToolError(`Downloading ${url} failed with HTTP ${response.status}.`, { code: "DOWNLOAD_FAILED" });
    }
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > MAX_UPLOAD_BYTES) {
      throw new ToolError(`${url} is too large to upload.`, { code: "FILE_TOO_LARGE" });
    }
    data = Buffer.from(await response.arrayBuffer());
    name = decodeURIComponent(basename(new URL(url).pathname)) || "file";
  }

  name = file.name ?? name;
  if (file.spoiler && !name.startsWith("SPOILER_")) name = `SPOILER_${name}`;
  return { name, data };
}

function toApiPoll(poll: PollInput): Record<string, unknown> {
  return {
    question: { text: poll.question },
    answers: poll.answers.map((text) => ({ poll_media: { text } })),
    duration: poll.duration_hours,
    allow_multiselect: poll.multiselect,
  };
}

/**
 * Posts one logical message: text over the limit is split into parts, the
 * reply reference goes on the first part, and embeds, files and polls go on
 * the last so they sit under the text they belong to.
 */
async function postMessage(ctx: ToolContext, channelId: string, input: PostInput): Promise<APIMessage[]> {
  const hasPayload = Boolean(input.embeds?.length || input.files?.length || input.poll);
  if (!input.content && !hasPayload) {
    throw new ToolError("Nothing to send: provide content, embeds, files or a poll.", {
      code: "EMPTY_MESSAGE",
      hint: "Set content to the message text.",
    });
  }

  const parts = input.content ? splitMessage(input.content) : [""];
  if (parts.length > MAX_PARTS) {
    throw new ToolError(`The text would need ${parts.length} messages; the maximum is ${MAX_PARTS}.`, {
      code: "TOO_LONG",
      hint: "Shorten the text, or attach it as a file instead.",
    });
  }

  const files = input.files?.length ? await Promise.all(input.files.map(loadFile)) : undefined;

  let flags = 0;
  if (input.silent) flags |= MessageFlags.SuppressNotifications;
  if (input.suppress_embeds) flags |= MessageFlags.SuppressEmbeds;

  const sent: APIMessage[] = [];
  for (const [index, part] of parts.entries()) {
    const first = index === 0;
    const last = index === parts.length - 1;

    const message = await ctx.rest.post<APIMessage>(
      Routes.channelMessages(channelId),
      {
        content: part || undefined,
        embeds: last ? input.embeds?.map(toApiEmbed) : undefined,
        poll: last && input.poll ? toApiPoll(input.poll) : undefined,
        allowed_mentions: mentionPolicy(input.allow_mentions),
        message_reference:
          first && input.reply_to ? { message_id: input.reply_to, fail_if_not_exists: false } : undefined,
        flags: flags || undefined,
      },
      undefined,
      last ? files : undefined,
    );
    sent.push(message);
  }

  return sent;
}

function sentOutcome(messages: APIMessage[], where: string): { summary: string; data: unknown } {
  const [first] = messages;
  if (messages.length === 1 && first) {
    return { summary: `Sent message ${first.id} to ${where}.`, data: formatMessage(first) };
  }
  return {
    summary: `Sent ${messages.length} messages to ${where} (text was split): ${messages.map((m) => m.id).join(", ")}.`,
    data: messages.map((m) => formatMessage(m)),
  };
}

export const sendMessage = defineTool({
  name: "discord_send_message",
  bulkArgs: ["channel"],
  title: "Send a Discord message",
  description:
    "Posts a message to a channel or thread: text, embeds, file uploads, polls and replies.\n\n" +
    "@mentions do NOT ping anyone unless allow_mentions is true, so names are safe in text. " +
    "Long text is split automatically. Returns the created message and its id.",
  inputSchema: {
    channel: channelRef,
    guild: guildRef.optional(),
    ...postShape,
    reply_to: messageId.optional().describe("Message ID to reply to."),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async handler(args, ctx) {
    const channelId = await resolveChannel(ctx, args.channel, args.guild);
    const messages = await postMessage(ctx, channelId, args);
    return sentOutcome(messages, `channel ${channelId}`);
  },
});

export const sendDirectMessage = defineTool({
  name: "discord_send_dm",
  bulkArgs: ["user"],
  title: "Send a direct message",
  description:
    "Sends a private DM to a user. The user must share a server with the bot and allow DMs from its members.\n\n" +
    "Accepts a user ID or @mention, or a member name looked up in `guild`. Same content options as " +
    "discord_send_message.",
  inputSchema: {
    user: memberRef.describe("Recipient: user ID, @mention, or username/nickname of a server member."),
    guild: guildRef.optional().describe("Server to look the name up in. Not needed for an ID."),
    ...postShape,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async handler(args, ctx) {
    const trimmed = args.user.trim();
    const mention = /^<@!?(\d{17,20})>$/.exec(trimmed)?.[1];
    const userId =
      mention ?? (isSnowflake(trimmed) ? trimmed : await ctx.resolver.memberId(trimmed, await ctx.resolver.guildId(args.guild)));

    const channelId = await ctx.resolver.dmChannel(userId);
    const messages = await postMessage(ctx, channelId, args);
    return sentOutcome(messages, `user ${userId} (DM)`);
  },
});

export const readMessages = defineTool({
  name: "discord_read_messages",
  bulkArgs: ["channel"],
  title: "Read Discord message history",
  description:
    "Reads recent messages from a channel or thread, newest first (set oldest_first for reading order).\n\n" +
    "Fetches up to 500 by paging automatically. Text is clipped to 500 chars per message in compact mode; " +
    "detail='full' allows 4000 and includes embed fields.\n\n" +
    "Without the MESSAGE CONTENT intent, content is empty for messages the bot did not send.",
  inputSchema: {
    channel: channelRef,
    guild: guildRef.optional(),
    limit: z.number().int().min(1).max(500).default(50).describe("How many messages to fetch (1-500)."),
    before: messageId.optional().describe("Only messages older than this message ID (paging back)."),
    after: messageId.optional().describe("Only messages newer than this message ID."),
    around: messageId.optional().describe("Messages centred on this message ID (max 100)."),
    from_author: memberRef.optional().describe("Keep only messages from this member (filters the fetched window)."),
    oldest_first: z.boolean().default(false).describe("Return in chronological order."),
    detail,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async handler(args, ctx) {
    const channelId = await resolveChannel(ctx, args.channel, args.guild);

    const [fetched, authorId] = await Promise.all([
      fetchHistory(ctx, channelId, { limit: args.limit, before: args.before, after: args.after, around: args.around }),
      args.from_author
        ? guildForChannel(ctx, channelId, args.guild).then((g) => ctx.resolver.memberId(args.from_author as string, g))
        : undefined,
    ]);

    let messages = authorId === undefined ? fetched : fetched.filter((m) => m.author.id === authorId);
    if (args.oldest_first) messages = [...messages].reverse();

    const oldest = fetched.length > 0 ? fetched[fetched.length - 1]?.id : undefined;
    const more =
      fetched.length >= args.limit && oldest && args.around === undefined && args.after === undefined
        ? ` Older messages exist: pass before=${oldest}.`
        : "";

    return {
      summary: `Read ${plural(messages.length, "message")} from channel ${channelId}.${more}`,
      data: messages.map((m) => formatMessage(m, args.detail)),
    };
  },
});

export const editMessage = defineTool({
  name: "discord_edit_message",
  bulkArgs: ["message_id"],
  title: "Edit a Discord message",
  description:
    "Edits a message the bot sent (bots cannot edit other users' messages). Omitted fields stay unchanged; " +
    "pass embeds: [] to remove all embeds.",
  inputSchema: {
    channel: channelRef,
    guild: guildRef.optional(),
    message_id: messageId,
    content: z.string().max(MESSAGE_LIMIT).optional().describe("Replacement text."),
    embeds: z.array(embedSchema).max(10).optional().describe("Replacement embeds; [] removes all."),
    allow_mentions: allowMentions,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async handler(args, ctx) {
    if (args.content === undefined && args.embeds === undefined) {
      throw new ToolError("Nothing to change: pass content, embeds, or both.", { code: "MISSING_ARG" });
    }

    const channelId = await resolveChannel(ctx, args.channel, args.guild);
    const message = await ctx.rest.patch<APIMessage>(Routes.channelMessage(channelId, args.message_id), {
      content: args.content,
      embeds: args.embeds?.map(toApiEmbed),
      allowed_mentions: mentionPolicy(args.allow_mentions),
    });

    return { summary: `Edited message ${message.id}.`, data: formatMessage(message) };
  },
});

/** True when Discord's bulk route will still accept this message. */
function bulkDeletable(id: string, now = Date.now()): boolean {
  const created = snowflakeMs(id);
  return created !== undefined && created > now - BULK_DELETE_MAX_AGE_MS + BULK_DELETE_MARGIN_MS;
}

/**
 * Deletes a set of messages in as few requests as possible: one bulk request
 * per 100 recent messages, and individual deletes only for those older than
 * 14 days (or when a bulk request is refused). Returns the ids that failed.
 */
export async function deleteMessages(
  ctx: ToolContext,
  channelId: string,
  ids: readonly string[],
  reason?: string,
): Promise<Map<string, unknown>> {
  const failures = new Map<string, unknown>();
  const unique = [...new Set(ids)];
  const recent = unique.filter((id) => bulkDeletable(id));
  const single = unique.filter((id) => !bulkDeletable(id));

  if (recent.length === 1) single.push(...recent);
  else {
    for (let i = 0; i < recent.length; i += 100) {
      const chunk = recent.slice(i, i + 100);
      if (chunk.length === 1) {
        single.push(...chunk);
        continue;
      }
      try {
        await ctx.rest.post(Routes.channelBulkDelete(channelId), { messages: chunk }, reason);
      } catch {
        // One bad id fails the whole chunk; retry individually for exact per-message results.
        single.push(...chunk);
      }
    }
  }

  const results = await mapWithConcurrency(
    single,
    ctx.config.batchConcurrency,
    (id) => ctx.rest.delete(Routes.channelMessage(channelId, id), reason),
    { signal: ctx.signal },
  );
  results.forEach((result, i) => {
    if (!result.ok) failures.set(single[i] as string, result.error);
  });

  return failures;
}

export const deleteMessage = defineTool({
  name: "discord_delete_message",
  bulkArgs: ["message_id"],
  missingPermissionHint: "Deleting someone else's message needs the Manage Messages permission in that channel.",
  title: "Delete Discord messages",
  description:
    "Permanently deletes a message. Pass an array of message_ids to delete many at once - recent ones " +
    "(< 14 days) go through Discord's bulk endpoint, 100 per request.\n\n" +
    "To purge by author or text instead of by id, use discord_bulk_delete.",
  destructive: true,
  inputSchema: {
    channel: channelRef,
    guild: guildRef.optional(),
    message_id: messageId,
    reason: z.string().max(512).optional().describe("Audit-log reason."),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  async bulkHandler(args, bulkArg, ids, ctx) {
    if (bulkArg !== "message_id" || ids.length < 2) return undefined;

    const channelId = await resolveChannel(ctx, args.channel, args.guild);
    const failures = await deleteMessages(ctx, channelId, ids, args.reason);

    return ids.map<BulkItem>((id) => {
      const failure = failures.get(id);
      return failure === undefined
        ? { value: id, ok: true, summary: `Deleted message ${id}.` }
        : { value: id, ok: false, error: errorText(failure) };
    });
  },
  async handler(args, ctx) {
    const channelId = await resolveChannel(ctx, args.channel, args.guild);
    await ctx.rest.delete(Routes.channelMessage(channelId, args.message_id), args.reason);
    return { summary: `Deleted message ${args.message_id} from channel ${channelId}.` };
  },
});

export const reactToMessage = defineTool({
  name: "discord_react",
  bulkArgs: ["emoji", "message_id"],
  missingPermissionHint:
    "Reacting needs Add Reactions and Read Message History in that channel. A deny on @everyone applies to the " +
    "bot too, so grant its role Add Reactions there with discord_set_channel_permissions.",
  title: "Add, remove or list reactions",
  description:
    "Adds or removes the bot's reaction on a message, or lists who reacted with an emoji (action='list').\n\n" +
    "Emoji may be unicode ('✅'), a server emoji by name ('partyparrot' or ':partyparrot:'), " +
    "'name:id', or '<:name:id>'.",
  inputSchema: {
    channel: channelRef,
    guild: guildRef.optional(),
    message_id: messageId,
    emoji: z.string().min(1).describe("Unicode emoji, server emoji name, 'name:id' or '<:name:id>'."),
    action: z.enum(["add", "remove", "list"]).default("add"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async handler(args, ctx) {
    const channelId = await resolveChannel(ctx, args.channel, args.guild);
    const emoji = encodeURIComponent(await resolveEmoji(ctx, args.emoji, channelId, args.guild));

    if (args.action === "list") {
      const users = await ctx.rest.get<APIUser[]>(Routes.channelMessageReaction(channelId, args.message_id, emoji), {
        limit: 100,
      });
      return {
        summary: `${plural(users.length, "user")} reacted with ${args.emoji} on ${args.message_id}.`,
        data: users.map(formatUser),
      };
    }

    const route = Routes.channelMessageOwnReaction(channelId, args.message_id, emoji);
    if (args.action === "add") await ctx.rest.put(route);
    else await ctx.rest.delete(route);

    return { summary: `${args.action === "add" ? "Added" : "Removed"} reaction ${args.emoji} on ${args.message_id}.` };
  },
});

export const pinMessage = defineTool({
  name: "discord_pin_message",
  bulkArgs: ["message_id"],
  missingPermissionHint:
    "Pinning needs the Pin Messages permission. Discord split this out of Manage Messages, so a bot " +
    "invited before that change will not have it - add it to the bot role under Server Settings -> Roles.",
  title: "Pin, unpin or list pinned messages",
  description:
    "Manages a channel's pins. action='list' returns current pins; 'pin' and 'unpin' need message_id. " +
    "A channel holds at most 50 pins.",
  inputSchema: {
    channel: channelRef,
    guild: guildRef.optional(),
    action: z.enum(["pin", "unpin", "list"]).default("list"),
    message_id: messageId.optional().describe("Required for pin and unpin."),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async handler(args, ctx) {
    const channelId = await resolveChannel(ctx, args.channel, args.guild);

    if (args.action === "list") {
      const pins = await ctx.rest.get<RESTGetAPIChannelMessagesPinsResult>(Routes.channelMessagesPins(channelId), {
        limit: 50,
      });
      return {
        summary: `${plural(pins.items.length, "pinned message")} in channel ${channelId}.`,
        data: pins.items.map((pin) => ({ ...formatMessage(pin.message), pinned_at: pin.pinned_at })),
      };
    }

    if (!args.message_id) {
      throw new ToolError(`message_id is required when action is "${args.action}".`, {
        code: "MISSING_ARG",
        hint: "Call this tool with action='list' first to find the message id.",
      });
    }

    const route = Routes.channelMessagesPin(channelId, args.message_id);
    if (args.action === "pin") await ctx.rest.put(route);
    else await ctx.rest.delete(route);

    return { summary: `${args.action === "pin" ? "Pinned" : "Unpinned"} message ${args.message_id}.` };
  },
});

export const searchMessages = defineTool({
  name: "discord_search_messages",
  title: "Search recent messages",
  description:
    "Searches recent history across channels for text (message content and embed text).\n\n" +
    "Bots cannot use Discord's search index, so this scans the newest per_channel_limit messages of each " +
    "channel (and active threads) in parallel. For older history page back with discord_read_messages.",
  inputSchema: {
    query: z.string().min(1).describe("Case-insensitive text to look for."),
    guild: guildRef.optional(),
    channels: z
      .array(channelRef)
      .max(25)
      .optional()
      .describe("Channels to scan. Defaults to every text channel and active thread."),
    from_author: memberRef.optional().describe("Only match messages by this member."),
    per_channel_limit: z.number().int().min(1).max(500).default(100),
    max_results: z.number().int().min(1).max(100).default(25),
    detail,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async handler(args, ctx) {
    const guildId = await ctx.resolver.guildId(args.guild);

    const [targets, authorId] = await Promise.all([
      args.channels
        ? Promise.all(args.channels.map((c) => ctx.resolver.channelId(c, guildId)))
        : Promise.all([ctx.resolver.channels(guildId), ctx.resolver.threads(guildId).catch(() => [])]).then(
            ([channels, threads]) => [...channels, ...threads].filter((c) => TEXTUAL_TYPES.has(c.type)).map((c) => c.id),
          ),
      args.from_author ? ctx.resolver.memberId(args.from_author, guildId) : undefined,
    ]);

    const needle = args.query.toLowerCase();

    // Every channel is its own rate-limit bucket, so scanning parallelises well
    // past the default batch concurrency.
    const scans = await mapWithConcurrency(
      targets,
      Math.max(ctx.config.batchConcurrency, 8),
      async (channelId) => {
        const messages = await fetchHistory(ctx, channelId, { limit: args.per_channel_limit });
        return messages
          .filter(
            (m) =>
              (authorId === undefined || m.author.id === authorId) &&
              searchableText(m).toLowerCase().includes(needle),
          )
          .map((m): CompactMessage & { channel_id: string } => ({ channel_id: channelId, ...formatMessage(m, args.detail) }));
      },
      { signal: ctx.signal },
    );

    const hits = scans.flatMap((r) => (r.ok ? r.value : []));
    const unreadable = scans.filter((r) => !r.ok).length;

    hits.sort((a, b) => compareSnowflakes(b.id, a.id));
    const trimmed = hits.slice(0, args.max_results);

    const skipped = unreadable > 0 ? ` ${plural(unreadable, "channel")} could not be read and were skipped.` : "";
    return {
      summary:
        `Found ${plural(hits.length, "match", "matches")} for "${args.query}" across ` +
        `${plural(targets.length, "channel")}; showing ${trimmed.length}.${skipped}`,
      data: trimmed,
    };
  },
});
