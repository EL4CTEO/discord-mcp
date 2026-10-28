import { z } from "zod";
import { DiscordAPIError } from "@discordjs/rest";
import { ChannelType, MessageFlags, MessageReferenceType, Routes } from "discord-api-types/v10";
import type {
  APIChannel,
  APIMessage,
  APIUser,
  RESTGetAPIChannelMessagesPinsResult,
  RESTGetAPIPollAnswerVotersResult,
} from "discord-api-types/v10";
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
import { formatMessage, formatPoll, formatUser, searchableText, snowflakeMs } from "../lib/format.js";
import type { CompactMessage } from "../lib/format.js";
import { ToolError } from "../lib/errors.js";
import { mapWithConcurrency } from "../lib/limiter.js";
import { MESSAGE_LIMIT, splitMessage } from "../lib/text.js";
import { loadUploads } from "../lib/upload.js";
import { isSnowflake } from "../discord/resolve.js";
import {
  allowMentions,
  channelRef,
  detail,
  embedList,
  guildRef,
  memberRef,
  mentionPolicy,
  messageId,
  toApiEmbed,
} from "../schemas/common.js";
import type { EmbedInput, MentionSetting } from "../schemas/common.js";

/** Channel types that actually hold readable message history. */
const TEXTUAL_TYPES = new Set<ChannelType>([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  ChannelType.AnnouncementThread,
  ChannelType.GuildVoice,
  ChannelType.GuildStageVoice,
]);

/** Discord refuses bulk deletes of anything older than this. */
export const BULK_DELETE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** Leeway so a message that ages past 14 days mid-request is not sent to the bulk route. */
const BULK_DELETE_MARGIN_MS = 60_000;

/** Long text is split into at most this many messages. */
const MAX_PARTS = 10;

/** Largest page Discord returns for user lists (reactions, poll voters). */
const USER_PAGE = 100;

/** Most users one call will list; beyond this the caller is told the list is capped. */
const USER_LIST_CAP = 1000;

/** Channels scanned by a search that names none: the most recently active ones. */
const SEARCH_DEFAULT_CHANNELS = 50;

/** Bulk-delete failures Discord pins on one message, so retrying ids one by one can isolate it. */
const PER_ID_DELETE_CODES = new Set<number>([10008, 50034, 50035]);

const fileSchema = z
  .object({
    path: z.string().min(1).optional().describe("Absolute local file path to upload (within the permitted upload folders)."),
    url: z.url({ protocol: /^https?$/ }).optional().describe("Public http(s) URL to download and re-upload."),
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
  allow_mentions: MentionSetting;
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
  embeds: embedList.optional().describe("Up to 10 rich embeds, at most 6000 characters of text across all of them."),
  files: z.array(fileSchema).max(10).optional().describe("Up to 10 attachments, from local paths or URLs."),
  poll: pollSchema.optional(),
  allow_mentions: allowMentions,
  silent: z.boolean().default(false).describe("Send without triggering a push notification."),
  suppress_embeds: z.boolean().optional().describe("Hide link previews."),
};

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

  if (input.suppress_embeds && input.embeds?.length) {
    throw new ToolError("suppress_embeds hides every embed on the message, including the ones being sent.", {
      code: "CONFLICTING_ARGS",
      hint: "Drop suppress_embeds to send these embeds, or drop embeds to hide link previews.",
    });
  }

  const parts = input.content ? splitMessage(input.content) : [""];
  if (parts.length > MAX_PARTS) {
    throw new ToolError(`The text would need ${parts.length} messages; the maximum is ${MAX_PARTS}.`, {
      code: "TOO_LONG",
      hint: "Shorten the text, or attach it as a file instead.",
    });
  }

  // Settled before any file is read or message sent, so a refused setting costs nothing.
  const allowedMentions = mentionPolicy(input.allow_mentions, ctx.config.allowMassMentions);
  const policy = { roots: ctx.config.uploadDirs, signal: ctx.signal, secrets: [ctx.config.token] };
  const files = input.files?.length ? await loadUploads(input.files, policy) : undefined;

  let flags = 0;
  if (input.silent) flags |= MessageFlags.SuppressNotifications;
  if (input.suppress_embeds) flags |= MessageFlags.SuppressEmbeds;

  const sent: APIMessage[] = [];
  for (const [index, part] of parts.entries()) {
    const first = index === 0;
    const last = index === parts.length - 1;

    let message: APIMessage;
    try {
      message = await ctx.rest.post<APIMessage>(
        Routes.channelMessages(channelId),
        {
          content: part || undefined,
          embeds: last ? input.embeds?.map(toApiEmbed) : undefined,
          poll: last && input.poll ? toApiPoll(input.poll) : undefined,
          allowed_mentions: allowedMentions,
          message_reference:
            first && input.reply_to ? { message_id: input.reply_to, fail_if_not_exists: false } : undefined,
          flags: flags || undefined,
        },
        undefined,
        last ? files : undefined,
      );
    } catch (error) {
      // Earlier parts are already live. Throwing without their ids would invite a
      // resend that duplicates them, so the ids go back with the error.
      if (sent.length === 0) throw error;
      throw new ToolError(
        `Sent ${sent.length} of ${parts.length} parts, then failed: ${errorText(error)}. ` +
          `Sent message ids: ${sent.map((m) => m.id).join(", ")}.`,
        {
          code: "PARTIAL_SEND",
          hint: "Do not resend the whole message; send only the remaining text.",
          cause: error,
        },
      );
    }
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
    "Posts a message to a channel or thread: text, embeds, file uploads, polls and replies, or forwards an " +
    "existing message (forward, on its own).\n\n" +
    "@mentions do NOT ping anyone unless allow_mentions is true, so names are safe in text. " +
    "Long text is split automatically. Returns the created message and its id.",
  inputSchema: {
    channel: channelRef,
    guild: guildRef.optional(),
    ...postShape,
    reply_to: messageId.optional().describe("Message ID to reply to."),
    forward: z
      .object({ channel: channelRef, message_id: messageId })
      .optional()
      .describe("Forward this message (from channel) into the target channel. Cannot be combined with other content."),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async handler(args, ctx) {
    const channelId = await resolveChannel(ctx, args.channel, args.guild);

    if (args.forward) {
      // Discord takes only a reference for a forward, so anything else would be dropped silently.
      const hasOther =
        args.content !== undefined ||
        (args.embeds?.length ?? 0) > 0 ||
        (args.files?.length ?? 0) > 0 ||
        args.poll !== undefined ||
        args.reply_to !== undefined;
      if (hasOther) {
        throw new ToolError(
          "A forward carries the original message as is: content, embeds, files, poll and reply_to cannot be combined with forward.",
          {
            code: "CONFLICTING_ARGS",
            hint: "Forward on its own, then send your own text as a separate message.",
          },
        );
      }

      const sourceId = await resolveChannel(ctx, args.forward.channel, args.guild);
      const message = await ctx.rest.post<APIMessage>(Routes.channelMessages(channelId), {
        message_reference: {
          type: MessageReferenceType.Forward,
          message_id: args.forward.message_id,
          channel_id: sourceId,
        },
        flags: args.silent ? MessageFlags.SuppressNotifications : undefined,
      });
      return {
        summary: `Forwarded message ${args.forward.message_id} from channel ${sourceId} to channel ${channelId} as ${message.id}.`,
        data: formatMessage(message),
      };
    }

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
    if (args.around !== undefined && args.limit > 100) {
      throw new ToolError(`limit is ${args.limit}, which cannot be combined with around.`, {
        code: "INVALID_ARGS",
        hint: "around returns at most 100 messages",
      });
    }

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
    embeds: embedList.optional().describe("Replacement embeds; [] removes all."),
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
      allowed_mentions: mentionPolicy(args.allow_mentions, ctx.config.allowMassMentions),
    });

    return { summary: `Edited message ${message.id}.`, data: formatMessage(message) };
  },
});

/** True when Discord's bulk route will still accept this message. */
function bulkDeletable(id: string, now = Date.now()): boolean {
  const created = snowflakeMs(id);
  return created !== undefined && created > now - BULK_DELETE_MAX_AGE_MS + BULK_DELETE_MARGIN_MS;
}

/** True when a failed bulk request was refused because of one of its ids. */
function isPerIdFailure(error: unknown): boolean {
  return error instanceof DiscordAPIError && typeof error.code === "number" && PER_ID_DELETE_CODES.has(error.code);
}

/**
 * Deletes a set of messages in as few requests as possible: one bulk request
 * per 100 recent messages, and individual deletes only for those older than
 * 14 days (or when Discord names one of a chunk's ids as the problem). Returns
 * the ids that failed.
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
      } catch (error) {
        // A permission or rate-limit refusal would fail every retry the same way,
        // so only an id-specific refusal is retried one by one.
        if (isPerIdFailure(error)) single.push(...chunk);
        else for (const id of chunk) failures.set(id, error);
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

    const channelId = await resolveChannel(ctx, args.channel, args.guild, { exact: true });
    const failures = await deleteMessages(ctx, channelId, ids, args.reason);

    return ids.map<BulkItem>((id) => {
      const failure = failures.get(id);
      return failure === undefined
        ? { value: id, ok: true, summary: `Deleted message ${id}.` }
        : { value: id, ok: false, error: errorText(failure) };
    });
  },
  async handler(args, ctx) {
    const channelId = await resolveChannel(ctx, args.channel, args.guild, { exact: true });
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
      const route = Routes.channelMessageReaction(channelId, args.message_id, emoji);
      const users: APIUser[] = [];
      let after: string | undefined;
      let capped = false;
      for (;;) {
        const page = await ctx.rest.get<APIUser[]>(route, { limit: USER_PAGE, after });
        users.push(...page);
        if (page.length < USER_PAGE) break;
        if (users.length >= USER_LIST_CAP) {
          capped = true;
          break;
        }
        after = page[page.length - 1]?.id;
      }
      const note = capped ? ` (capped at ${USER_LIST_CAP}; more users may have reacted)` : "";
      return {
        summary: `${plural(users.length, "user")} reacted with ${args.emoji} on ${args.message_id}${note}.`,
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

export const managePoll = defineTool({
  name: "discord_manage_poll",
  missingPermissionHint:
    "Reading a poll needs View Channel and Read Message History in its channel. Ending one only works for polls " +
    "the bot posted itself: Discord refuses to end another user's poll.",
  title: "Read, list voters of, or end a poll",
  description:
    "Works on the poll attached to a message. action='results' (default) returns the question, each answer's " +
    "vote count and whether the poll is finalized. 'voters' lists who chose answer_id, up to limit. 'end' closes " +
    "a poll early so no more votes count; only polls the bot posted itself can be ended.",
  inputSchema: {
    channel: channelRef,
    guild: guildRef.optional(),
    message_id: messageId,
    action: z.enum(["results", "voters", "end"]).default("results"),
    answer_id: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Answer to list voters for. Required for 'voters'; the ids come from 'results'."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(USER_LIST_CAP)
      .default(100)
      .describe("How many voters to return for 'voters' (1-1000)."),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async handler(args, ctx) {
    const channelId = await resolveChannel(ctx, args.channel, args.guild);

    if (args.action === "end") {
      const message = await ctx.rest.post<APIMessage>(Routes.expirePoll(channelId, args.message_id));
      return {
        summary: `Ended the poll on message ${args.message_id}; no more votes will count.`,
        data: formatMessage(message),
      };
    }

    if (args.action === "voters") {
      if (args.answer_id === undefined) {
        throw new ToolError('answer_id is required when action is "voters".', {
          code: "MISSING_ARG",
          hint: "Call with action='results' to find the answer ids.",
        });
      }

      const voters: APIUser[] = [];
      let after: string | undefined;
      for (;;) {
        const want = Math.min(USER_PAGE, args.limit - voters.length);
        const page = await ctx.rest.get<RESTGetAPIPollAnswerVotersResult>(
          Routes.pollAnswerVoters(channelId, args.message_id, args.answer_id),
          { limit: want, after },
        );
        voters.push(...page.users);
        if (page.users.length < want || voters.length >= args.limit) break;
        after = page.users[page.users.length - 1]?.id;
      }

      const note = voters.length >= args.limit ? ` (stopped at limit ${args.limit}; more may exist)` : "";
      return {
        summary: `${plural(voters.length, "voter")} for answer ${args.answer_id} on message ${args.message_id}${note}.`,
        data: voters.map(formatUser),
      };
    }

    const message = await ctx.rest.get<APIMessage>(Routes.channelMessage(channelId, args.message_id));
    if (!message.poll) {
      throw new ToolError(`Message ${args.message_id} has no poll.`, {
        code: "NOT_FOUND",
        hint: "Pass the ID of the message that shows the poll.",
      });
    }

    const poll = formatPoll(message.poll);
    const counted = poll.answers.some((a) => a.votes !== undefined);
    const votes = poll.answers.reduce((sum, a) => sum + (a.votes ?? 0), 0);
    const tally = counted ? plural(votes, "vote") + " counted" : "vote counts not returned";
    return {
      summary: `Poll on message ${args.message_id}: ${tally}${poll.finalized ? ", finalized" : ""}.`,
      data: poll,
    };
  },
});

/** Newest activity first; a channel that has never had a message goes last. */
function byRecentActivity(a: APIChannel, b: APIChannel): number {
  const latestA = lastMessageId(a);
  const latestB = lastMessageId(b);
  if (latestA === undefined || latestB === undefined) {
    return Number(latestA === undefined) - Number(latestB === undefined);
  }
  return compareSnowflakes(latestB, latestA);
}

function lastMessageId(channel: APIChannel): string | undefined {
  return "last_message_id" in channel ? (channel.last_message_id ?? undefined) : undefined;
}

/**
 * The channels a search scans when none are named: the most recently active
 * text channels and threads, up to SEARCH_DEFAULT_CHANNELS. Scanning every
 * channel of a large server costs a request each and runs into rate limits.
 */
async function defaultSearchTargets(
  ctx: ToolContext,
  guildId: string,
): Promise<{ targets: string[]; skipped: number }> {
  const [channels, threads] = await Promise.all([
    ctx.resolver.channels(guildId),
    ctx.resolver.threads(guildId).catch(() => []),
  ]);
  const textual = [...channels, ...threads].filter((c) => TEXTUAL_TYPES.has(c.type)).sort(byRecentActivity);
  const targets = textual.slice(0, SEARCH_DEFAULT_CHANNELS).map((c) => c.id);
  return { targets, skipped: textual.length - targets.length };
}

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
      .describe("Channels to scan. Defaults to the 50 most recently active text channels and threads."),
    from_author: memberRef.optional().describe("Only match messages by this member."),
    per_channel_limit: z.number().int().min(1).max(500).default(100),
    max_results: z.number().int().min(1).max(100).default(25),
    detail,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async handler(args, ctx) {
    const guildId = await ctx.resolver.guildId(args.guild);

    const [scope, authorId] = await Promise.all([
      args.channels
        ? Promise.all(args.channels.map((c) => ctx.resolver.channelId(c, guildId))).then((targets) => ({
            // "general" and its ID are the same channel; scanning it twice would double its hits.
            targets: [...new Set(targets)],
            skipped: 0,
          }))
        : defaultSearchTargets(ctx, guildId),
      args.from_author ? ctx.resolver.memberId(args.from_author, guildId) : undefined,
    ]);
    const { targets, skipped } = scope;

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
          .map((message) => ({ channelId, message }));
      },
      { signal: ctx.signal },
    );

    const hits = scans.flatMap((r) => (r.ok ? r.value : []));
    const unreadable = scans.filter((r) => !r.ok).length;

    // Only the hits that are returned get formatted.
    hits.sort((a, b) => compareSnowflakes(b.message.id, a.message.id));
    const trimmed = hits
      .slice(0, args.max_results)
      .map(({ channelId, message }): CompactMessage & { channel_id: string } => ({
        channel_id: channelId,
        ...formatMessage(message, args.detail),
      }));

    const unreadableNote = unreadable > 0 ? ` ${plural(unreadable, "channel")} could not be read and were skipped.` : "";
    const unsearchedNote =
      skipped > 0 ? ` ${plural(skipped, "less active channel")} not searched; pass channels to search them.` : "";
    return {
      summary:
        `Found ${plural(hits.length, "match", "matches")} for "${args.query}" across ` +
        `${plural(targets.length, "channel")}; showing ${trimmed.length}.${unreadableNote}${unsearchedNote}`,
      data: trimmed,
    };
  },
});
