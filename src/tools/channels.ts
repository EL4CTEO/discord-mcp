import { z } from "zod";
import { ChannelType, PermissionFlagsBits, Routes } from "discord-api-types/v10";
import type { APIChannel, APIOverwrite, APIThreadChannel } from "discord-api-types/v10";
import { defineTool, errorText } from "./registry.js";
import type { ToolContext } from "./registry.js";
import { plural, resolveGuildChannel, resolveOverwriteTarget } from "./util.js";
import { channelTypeName, formatChannel, THREAD_TYPES } from "../lib/format.js";
import type { CompactChannel } from "../lib/format.js";
import { ToolError } from "../lib/errors.js";
import { assertMayGrant } from "../lib/guards.js";
import { auditReason, channelRef, detail, guildRef, messageId } from "../schemas/common.js";
import { channelPermissionList, permissionNames, toBitfield } from "../schemas/permissions.js";

/** Friendly names accepted by create/list, mapped to Discord's numeric types. */
const CREATABLE = {
  text: ChannelType.GuildText,
  voice: ChannelType.GuildVoice,
  category: ChannelType.GuildCategory,
  announcement: ChannelType.GuildAnnouncement,
  stage: ChannelType.GuildStageVoice,
  forum: ChannelType.GuildForum,
  media: ChannelType.GuildMedia,
} as const;

const VOICE_TYPES = new Set<ChannelType>([ChannelType.GuildVoice, ChannelType.GuildStageVoice]);
const FORUM_TYPES = new Set<ChannelType>([ChannelType.GuildForum, ChannelType.GuildMedia]);

/** Limits for plain channels. Forum and media channels allow longer topics; stage channels allow larger user limits. */
const PLAIN_TOPIC_MAX = 1024;
const PLAIN_USER_LIMIT_MAX = 99;

const targetType = z
  .enum(["auto", "role", "member"])
  .default("auto")
  .describe("Whether `target` is a role or a member. 'auto' tries a role first, then a member.");

const overwriteSchema = z.object({
  target: z.string().min(1).describe("Role or member. Use '@everyone' for the default role."),
  target_type: targetType,
  allow: channelPermissionList.optional(),
  deny: channelPermissionList.optional(),
});

function position(channel: APIChannel): number {
  return "position" in channel && typeof channel.position === "number" ? channel.position : 0;
}

function parentOf(channel: APIChannel): string | null {
  return "parent_id" in channel && channel.parent_id ? channel.parent_id : null;
}

/**
 * Discord's own display order: position first, with voice channels sorted
 * below text channels in the same category, and IDs breaking ties.
 */
function displayOrder(a: APIChannel, b: APIChannel): number {
  const voiceA = VOICE_TYPES.has(a.type) ? 1 : 0;
  const voiceB = VOICE_TYPES.has(b.type) ? 1 : 0;
  return voiceA - voiceB || position(a) - position(b) || (a.id < b.id ? -1 : 1);
}

export const listChannels = defineTool({
  name: "discord_list_channels",
  title: "List server channels",
  description:
    "Lists every channel in a server in the order Discord shows them, each tagged with its category.\n\n" +
    "Start here when you need a channel id or want to see how a server is organised. Filter with `type`; " +
    "set include_threads to also list active threads.",
  inputSchema: {
    guild: guildRef.optional(),
    type: z
      .enum(["text", "voice", "category", "announcement", "stage", "forum", "media", "all"])
      .default("all")
      .describe("Restrict results to one channel type."),
    include_threads: z.boolean().default(false).describe("Also list active threads under their parent."),
    detail,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async handler(args, ctx) {
    const guildId = await ctx.resolver.guildId(args.guild);
    const [channels, threads] = await Promise.all([
      ctx.resolver.channels(guildId),
      args.include_threads ? ctx.resolver.threads(guildId) : Promise.resolve([] as APIThreadChannel[]),
    ]);

    const categories = channels.filter((c) => c.type === ChannelType.GuildCategory).sort(displayOrder);
    const categoryName = new Map(categories.map((c) => [c.id, "name" in c ? (c.name ?? "") : ""]));
    const threadsByParent = new Map<string, APIThreadChannel[]>();
    for (const thread of threads) {
      const key = thread.parent_id ?? "";
      const siblings = threadsByParent.get(key);
      if (siblings) siblings.push(thread);
      else threadsByParent.set(key, [thread]);
    }

    // Uncategorised channels first, then each category followed by its children.
    const ordered: APIChannel[] = [];
    const children = (parent: string | null): APIChannel[] =>
      channels.filter((c) => c.type !== ChannelType.GuildCategory && parentOf(c) === parent).sort(displayOrder);
    const push = (channel: APIChannel): void => {
      ordered.push(channel);
      ordered.push(...(threadsByParent.get(channel.id) ?? []));
    };

    children(null).forEach(push);
    for (const category of categories) {
      ordered.push(category);
      children(category.id).forEach(push);
    }

    const wanted = args.type === "all" ? undefined : CREATABLE[args.type];
    const data: Array<CompactChannel & { category?: string }> = ordered
      .filter((c) => wanted === undefined || c.type === wanted || (THREAD_TYPES.includes(c.type) && args.include_threads))
      .map((c) => {
        const base = formatChannel(c, args.detail);
        const parent = parentOf(c);
        const category = parent === null ? undefined : categoryName.get(parent);
        return category === undefined ? base : { ...base, category };
      });

    return { summary: `${plural(data.length, "channel")} in server ${guildId}, in display order.`, data };
  },
});

/** Resolves overwrite specs into Discord's wire format. */
async function toOverwrites(
  ctx: ToolContext,
  guildId: string,
  specs: ReadonlyArray<z.infer<typeof overwriteSchema>>,
): Promise<APIOverwrite[]> {
  return Promise.all(
    specs.map(async (spec) => {
      // Same gate as discord_set_channel_permissions, or this path would be the way around it.
      assertMayGrant(toBitfield(spec.allow), ctx.config.allowDestructive, `${spec.target} on the new channel`);
      const target = await resolveOverwriteTarget(ctx, spec.target, spec.target_type, guildId);
      return { id: target.id, type: target.type, allow: toBitfield(spec.allow), deny: toBitfield(spec.deny) };
    }),
  );
}

export const createChannel = defineTool({
  name: "discord_create_channel",
  bulkArgs: ["name"],
  title: "Create a channel",
  description:
    "Creates a text, voice, category, announcement, stage, forum or media channel.\n\n" +
    "Nest it with `category` (create the category first if needed). `permissions` sets overwrites in the same " +
    "request - e.g. a private staff channel: [{target:'@everyone', deny:['ViewChannel']}, " +
    "{target:'Moderator', allow:['ViewChannel']}]. Without `permissions` a channel inside a category inherits " +
    "the category's permissions.",
  inputSchema: {
    name: z.string().min(1).max(100).describe("Channel name. Discord lowercases and hyphenates text channel names."),
    guild: guildRef.optional(),
    type: z.enum(["text", "voice", "category", "announcement", "stage", "forum", "media"]).default("text"),
    category: channelRef.optional().describe("Parent category to place this channel in."),
    topic: z
      .string()
      .max(4096)
      .optional()
      .describe("Channel topic / description. Up to 1024 characters, or 4096 for forum and media channels."),
    nsfw: z.boolean().optional(),
    slowmode_seconds: z.number().int().min(0).max(21600).optional().describe("Per-user rate limit, 0 to disable."),
    user_limit: z
      .number()
      .int()
      .min(0)
      .max(10000)
      .optional()
      .describe("Voice only: max members, 0 for unlimited. Up to 99, or 10000 for stage channels."),
    position: z.number().int().min(0).optional(),
    permissions: z.array(overwriteSchema).max(50).optional().describe("Permission overwrites to apply on creation."),
    reason: auditReason,
  },
  missingPermissionHint:
    "Needs Manage Channels; setting permissions also needs Manage Roles, and the bot can only grant permissions it holds.",
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async handler(args, ctx) {
    const kind = CREATABLE[args.type];
    if (args.topic !== undefined && args.topic.length > PLAIN_TOPIC_MAX && !FORUM_TYPES.has(kind)) {
      throw new ToolError(`A ${args.type} channel's topic is limited to ${PLAIN_TOPIC_MAX} characters.`, {
        code: "INVALID_ARGS",
        hint: "Shorten the topic, or create a forum or media channel, which allow 4096.",
      });
    }
    const plainLimit = kind !== ChannelType.GuildStageVoice;
    if (args.user_limit !== undefined && args.user_limit > PLAIN_USER_LIMIT_MAX && plainLimit) {
      throw new ToolError(`A ${args.type} channel's user limit is capped at ${PLAIN_USER_LIMIT_MAX}.`, {
        code: "INVALID_ARGS",
        hint: "Use a limit of 99 or less, or create a stage channel, which allows up to 10000.",
      });
    }

    const guildId = await ctx.resolver.guildId(args.guild);
    const [parentId, overwrites] = await Promise.all([
      args.category ? ctx.resolver.channelId(args.category, guildId) : undefined,
      args.permissions ? toOverwrites(ctx, guildId, args.permissions) : undefined,
    ]);

    // Discord only copies category permissions when none are given, so an
    // explicit list is layered on top of the category's own overwrites.
    let permissionOverwrites = overwrites;
    if (overwrites && parentId) {
      // Read fresh: a stale copy could carry a category's old, public overwrites into a private channel.
      const parent = await ctx.rest.get<APIChannel>(Routes.channel(parentId));
      const inherited = parent && "permission_overwrites" in parent ? (parent.permission_overwrites ?? []) : [];
      const explicit = new Set(overwrites.map((o) => o.id));
      permissionOverwrites = [...inherited.filter((o) => !explicit.has(o.id)), ...overwrites];
    }

    const channel = await ctx.rest.post<APIChannel>(
      Routes.guildChannels(guildId),
      {
        name: args.name,
        type: CREATABLE[args.type],
        parent_id: parentId,
        topic: args.topic,
        nsfw: args.nsfw,
        rate_limit_per_user: args.slowmode_seconds,
        user_limit: args.user_limit,
        position: args.position,
        permission_overwrites: permissionOverwrites,
      },
      args.reason,
    );

    ctx.resolver.upsertChannel(guildId, channel);
    return { summary: `Created ${args.type} channel "${args.name}" (${channel.id}).`, data: formatChannel(channel) };
  },
});

export const editChannel = defineTool({
  name: "discord_edit_channel",
  bulkArgs: ["channel"],
  title: "Edit a channel",
  description:
    "Updates a channel's settings; only the fields you pass change.\n\n" +
    "Rename, set a topic, toggle NSFW, change slowmode or voice user limit, or move it: `category` moves it " +
    "under a category, `category: null` moves it to the top level.",
  inputSchema: {
    channel: channelRef,
    guild: guildRef.optional(),
    name: z.string().min(1).max(100).optional(),
    topic: z
      .string()
      .max(4096)
      .optional()
      .describe("New topic; '' clears it. Up to 1024 characters, or 4096 for forum and media channels."),
    nsfw: z.boolean().optional(),
    slowmode_seconds: z.number().int().min(0).max(21600).optional(),
    user_limit: z
      .number()
      .int()
      .min(0)
      .max(10000)
      .optional()
      .describe("Voice only. Up to 99, or 10000 for stage channels."),
    position: z.number().int().min(0).optional(),
    category: channelRef.nullable().optional().describe("Move under this category, or null for the top level."),
    sync_permissions: z.boolean().optional().describe("When moving, adopt the new category's permissions."),
    reason: auditReason,
  },
  missingPermissionHint: "Needs the Manage Channels permission on that channel.",
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async handler(args, ctx) {
    const { channel: _c, guild: _g, reason: _r, ...changes } = args;
    if (Object.values(changes).every((v) => v === undefined)) {
      throw new ToolError("Nothing to change: pass at least one field to update.", { code: "MISSING_ARG" });
    }
    if (args.sync_permissions !== undefined && args.category === undefined) {
      throw new ToolError("`sync_permissions` only applies when moving the channel with `category`.", {
        code: "MISSING_ARG",
        hint: "Pass `category` alongside sync_permissions, or drop sync_permissions.",
      });
    }

    const { guildId, channelId } = await resolveGuildChannel(ctx, args.channel, args.guild);

    // Only a channel the cache knows can be judged here; anything unknown is left to Discord.
    const needsLargeLimits =
      (args.topic?.length ?? 0) > PLAIN_TOPIC_MAX || (args.user_limit ?? 0) > PLAIN_USER_LIMIT_MAX;
    const known = needsLargeLimits ? await ctx.resolver.findChannel(guildId, channelId) : undefined;
    const plainTopic = known !== undefined && !FORUM_TYPES.has(known.type);
    const plainLimit = known !== undefined && known.type !== ChannelType.GuildStageVoice;
    if (plainTopic && args.topic !== undefined && args.topic.length > PLAIN_TOPIC_MAX) {
      throw new ToolError(`This channel's topic is limited to ${PLAIN_TOPIC_MAX} characters.`, {
        code: "INVALID_ARGS",
        hint: "Shorten the topic. Only forum and media channels allow 4096.",
      });
    }
    if (plainLimit && args.user_limit !== undefined && args.user_limit > PLAIN_USER_LIMIT_MAX) {
      throw new ToolError(`This channel's user limit is capped at ${PLAIN_USER_LIMIT_MAX}.`, {
        code: "INVALID_ARGS",
        hint: "Use a limit of 99 or less. Only stage channels allow up to 10000.",
      });
    }

    const parentId =
      args.category === undefined
        ? undefined
        : args.category === null
          ? null
          : await ctx.resolver.channelId(args.category, guildId);

    // Discord's channel PATCH has no lock_permissions field. Syncing overwrites
    // only happens on the guild positions route, so a sync move goes through it.
    const syncMove = args.sync_permissions === true && parentId !== undefined;
    if (syncMove && !ctx.config.allowDestructive) {
      const current = await ctx.rest.get<APIChannel>(Routes.channel(channelId));
      if (hidesFromSomeone(current)) {
        throw new ToolError("Refused: syncing would replace this private channel's overwrites and could expose it.", {
          code: "EXPOSES_CHANNEL",
          hint:
            "Move it without sync_permissions to keep its overwrites, or the operator can set " +
            "DISCORD_ALLOW_DESTRUCTIVE=true.",
        });
      }
      // Syncing copies the category's grants onto this channel, which is a grant in itself.
      if (parentId !== null) {
        const parent = await ctx.rest.get<APIChannel>(Routes.channel(parentId));
        const own = new Map(overwritesOf(current).map((o) => [o.id, BigInt(o.allow)]));
        for (const o of overwritesOf(parent)) {
          assertMayGrant(BigInt(o.allow) & ~(own.get(o.id) ?? 0n), false, `overwrite ${o.id} copied from the category`);
        }
      }
    }
    if (syncMove) {
      await ctx.rest.patch(
        Routes.guildChannels(guildId),
        [{ id: channelId, parent_id: parentId, lock_permissions: true }],
        args.reason,
      );
    }

    const body = {
      name: args.name,
      topic: args.topic,
      nsfw: args.nsfw,
      rate_limit_per_user: args.slowmode_seconds,
      user_limit: args.user_limit,
      position: args.position,
      parent_id: syncMove ? undefined : parentId,
    };
    const hasChanges = Object.values(body).some((v) => v !== undefined);
    // The positions route returns nothing, so a sync move without other edits refetches the channel.
    const channel = hasChanges
      ? await ctx.rest.patch<APIChannel>(Routes.channel(channelId), body, args.reason)
      : await ctx.rest.get<APIChannel>(Routes.channel(channelId));

    // A sync move can renumber sibling channels, which the cache cannot fold in.
    if (syncMove) ctx.resolver.invalidateChannels(guildId);
    else ctx.resolver.upsertChannel(guildId, channel);
    return { summary: `Updated channel ${channelId}.`, data: formatChannel(channel, "full") };
  },
});

export const deleteChannel = defineTool({
  name: "discord_delete_channel",
  bulkArgs: ["channel"],
  title: "Delete a channel",
  description:
    "Permanently deletes a channel or thread and all of its messages. Cannot be undone.\n\n" +
    "Deleting a category does NOT delete the channels inside it; they move to the top level.",
  destructive: true,
  inputSchema: { channel: channelRef, guild: guildRef.optional(), reason: auditReason },
  missingPermissionHint: "Needs the Manage Channels permission (Manage Threads for threads).",
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  async handler(args, ctx) {
    const { guildId, channelId } = await resolveGuildChannel(ctx, args.channel, args.guild, { exact: true });
    const deleted = await ctx.rest.delete<APIChannel>(Routes.channel(channelId), args.reason);

    // Children of a deleted category move to the top level, so their cached parent ids are stale.
    if (deleted.type === ChannelType.GuildCategory) ctx.resolver.invalidateChannels(guildId);
    else ctx.resolver.removeChannel(guildId, channelId);
    const name = "name" in deleted && deleted.name ? deleted.name : channelId;
    return { summary: `Deleted ${channelTypeName(deleted.type)} channel "${name}".` };
  },
});

export const manageThread = defineTool({
  name: "discord_manage_thread",
  missingPermissionHint:
    "Needs Create Public/Private Threads (Send Messages for forum posts) to create, or Manage Threads to " +
    "archive, lock or unlock.",
  title: "Create or manage a thread or forum post",
  description:
    "Creates threads and changes their state.\n\n" +
    "- create: in a text channel pass `message_id` to branch off a message, or omit it for a standalone " +
    "thread. In a forum channel this creates a post and `content` is its required first message.\n" +
    "- archive / unarchive / lock / unlock: change an existing thread's state.\n" +
    "- list: active threads in the server, or only under `channel` if given.",
  inputSchema: {
    action: z.enum(["create", "archive", "unarchive", "lock", "unlock", "list"]),
    channel: channelRef.optional().describe("Parent channel for create/list; the thread itself for state changes."),
    guild: guildRef.optional(),
    name: z.string().min(1).max(100).optional().describe("Thread name. Required for create."),
    content: z.string().min(1).max(2000).optional().describe("First message. Required for forum posts."),
    message_id: messageId.optional().describe("Branch the thread off this message (create only)."),
    auto_archive_minutes: z
      .union([z.literal(60), z.literal(1440), z.literal(4320), z.literal(10080)])
      .default(1440)
      .describe("Idle time before Discord auto-archives the thread: 60, 1440, 4320 or 10080 minutes."),
    private: z.boolean().default(false).describe("Create a private thread (create only, text channels)."),
    reason: auditReason,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async handler(args, ctx) {
    if (args.action === "list") {
      const guildId = await ctx.resolver.guildId(args.guild);
      const [threads, parentId] = await Promise.all([
        ctx.resolver.threads(guildId),
        args.channel ? ctx.resolver.channelId(args.channel, guildId) : undefined,
      ]);
      const shown = parentId === undefined ? threads : threads.filter((t) => t.parent_id === parentId);
      return {
        summary: `${plural(shown.length, "active thread")} in ${parentId ? `channel ${parentId}` : `server ${guildId}`}.`,
        data: shown.map((t) => formatChannel(t)),
      };
    }

    if (!args.channel) {
      throw new ToolError("`channel` is required for this action.", {
        code: "MISSING_ARG",
        hint: "For create pass the parent channel; for state changes pass the thread itself.",
      });
    }

    if (args.action === "create") {
      if (!args.name) {
        throw new ToolError("`name` is required when creating a thread.", { code: "MISSING_ARG" });
      }

      const { guildId, channelId } = await resolveGuildChannel(ctx, args.channel, args.guild);
      const parent = await ctx.resolver.findChannel(guildId, channelId);
      const isForum = parent !== undefined && FORUM_TYPES.has(parent.type);

      if (isForum && !args.content) {
        throw new ToolError("A forum post needs a first message.", {
          code: "MISSING_ARG",
          hint: "Pass `content` with the text of the post.",
        });
      }

      const thread = await ctx.rest.post<APIThreadChannel>(
        Routes.threads(channelId, isForum ? undefined : args.message_id),
        {
          name: args.name,
          auto_archive_duration: args.auto_archive_minutes,
          ...(isForum
            ? { message: { content: args.content, allowed_mentions: { parse: [] } } }
            : {
                type: args.message_id
                  ? undefined
                  : args.private
                    ? ChannelType.PrivateThread
                    : ChannelType.PublicThread,
              }),
        },
        args.reason,
      );
      ctx.resolver.invalidateThreads(guildId);

      // Text-channel threads start empty; post the opening message into them.
      // The thread already exists, so a failed post is reported rather than thrown:
      // a retry would otherwise create a second thread.
      if (!isForum && args.content) {
        try {
          await ctx.rest.post(Routes.channelMessages(thread.id), {
            content: args.content,
            allowed_mentions: { parse: [] },
          });
        } catch (error) {
          const reason = errorText(error);
          return {
            summary: `Created thread "${args.name}" (${thread.id}), but posting the first message failed: ${reason}`,
            data: formatChannel(thread),
          };
        }
      }

      return {
        summary: `Created ${isForum ? "forum post" : "thread"} "${args.name}" (${thread.id}).`,
        data: formatChannel(thread),
      };
    }

    const { guildId, channelId } = await resolveGuildChannel(ctx, args.channel, args.guild);
    const state = {
      archive: { archived: true },
      unarchive: { archived: false },
      lock: { locked: true },
      unlock: { locked: false },
    }[args.action];

    const thread = await ctx.rest.patch<APIThreadChannel>(Routes.channel(channelId), state, args.reason);
    ctx.resolver.invalidateThreads(guildId);
    return { summary: `Thread ${channelId}: ${args.action} applied.`, data: formatChannel(thread) };
  },
});

function overwritesOf(channel: APIChannel | undefined): APIOverwrite[] {
  return channel && "permission_overwrites" in channel ? (channel.permission_overwrites ?? []) : [];
}

/**
 * True when some overwrite on the channel denies View Channel, i.e. it is
 * private to someone. Only the channel's own overwrites count: Discord copies
 * a category's overwrites on sync, it does not inherit them at runtime.
 */
function hidesFromSomeone(channel: APIChannel | undefined): boolean {
  return overwritesOf(channel).some((o) => (BigInt(o.deny) & PermissionFlagsBits.ViewChannel) !== 0n);
}

export const setChannelPermissions = defineTool({
  name: "discord_set_channel_permissions",
  bulkArgs: ["channel", "target"],
  title: "Set channel permission overwrites",
  description:
    "Grants or denies permissions for one role or member on a channel.\n\n" +
    "- Read-only for everyone: target='@everyone', deny=['SendMessages','AddReactions','CreatePublicThreads']\n" +
    "- Private channel: target='@everyone', deny=['ViewChannel'], then allow ViewChannel for the role that should see it\n\n" +
    "mode='merge' (default) changes only the listed permissions and keeps the rest of the existing overwrite; " +
    "'replace' makes allow/deny the whole overwrite; 'reset' removes the overwrite so everything inherits again.\n\n" +
    "A deny on @everyone applies to the bot too - grant the bot's role what it still needs there.",
  inputSchema: {
    channel: channelRef,
    guild: guildRef.optional(),
    target: z.string().min(1).describe("Role or member to overwrite. Use '@everyone' for the default role."),
    target_type: targetType,
    allow: channelPermissionList.optional().describe("Permissions to explicitly grant."),
    deny: channelPermissionList.optional().describe("Permissions to explicitly deny."),
    mode: z.enum(["merge", "replace", "reset"]).default("merge"),
    reason: auditReason,
  },
  missingPermissionHint:
    "Editing channel permissions needs Manage Roles, and a bot can only grant permissions it holds itself.",
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async handler(args, ctx) {
    if (args.mode !== "reset" && !args.allow?.length && !args.deny?.length) {
      throw new ToolError("Nothing to apply: pass at least one permission in `allow` or `deny`.", {
        code: "MISSING_ARG",
        hint: "For a read-only channel try deny: ['SendMessages','AddReactions','CreatePublicThreads'], or mode 'reset'.",
      });
    }

    const overlap = args.allow?.filter((p) => args.deny?.includes(p)) ?? [];
    if (overlap.length > 0) {
      throw new ToolError(`These permissions are in both allow and deny: ${overlap.join(", ")}.`, {
        code: "CONFLICTING_ARGS",
        hint: "A permission can be allowed or denied, not both. Remove it from one list.",
      });
    }

    const { guildId, channelId } = await resolveGuildChannel(ctx, args.channel, args.guild);
    const target = await resolveOverwriteTarget(ctx, args.target, args.target_type, guildId);
    const route = Routes.channelPermission(channelId, target.id);

    const channel = await ctx.rest.get<APIChannel>(Routes.channel(channelId));
    const existing =
      "permission_overwrites" in channel ? channel.permission_overwrites?.find((o) => o.id === target.id) : undefined;

    // Bitfields are merged as bigints, so bits the curated list does not name survive a merge.
    let allowBits = BigInt(toBitfield(args.allow));
    let denyBits = BigInt(toBitfield(args.deny));
    if (args.mode === "reset") {
      allowBits = 0n;
      denyBits = 0n;
    } else if (args.mode === "merge" && existing) {
      // Anything newly allowed stops being denied, and vice versa.
      allowBits = (BigInt(existing.allow) & ~denyBits) | allowBits;
      denyBits = (BigInt(existing.deny) & ~allowBits) | denyBits;
    }

    // Grants of admin-grade permissions, and lifting the deny that keeps a
    // channel private, are what an injected instruction would ask for, so both
    // sit behind the destructive switch. Ordinary locks and unlocks do not.
    const alreadyAllowed = existing ? BigInt(existing.allow) : 0n;
    assertMayGrant(allowBits & ~alreadyAllowed, ctx.config.allowDestructive, `${args.target} on this channel`);
    const wasHidden = existing !== undefined && (BigInt(existing.deny) & PermissionFlagsBits.ViewChannel) !== 0n;
    if (wasHidden && (denyBits & PermissionFlagsBits.ViewChannel) === 0n && !ctx.config.allowDestructive) {
      throw new ToolError(`Refused: this would let ${args.target} see a channel currently hidden from them.`, {
        code: "EXPOSES_CHANNEL",
        hint:
          "Exposing a private channel is gated like other destructive actions. The operator can set " +
          "DISCORD_ALLOW_DESTRUCTIVE=true, or change it by hand in the channel settings.",
      });
    }

    // The channel was just read fresh, so the change folds into the cache instead of forcing a relisting.
    const others = overwritesOf(channel).filter((o) => o.id !== target.id);

    if (args.mode === "reset") {
      await ctx.rest.delete(route, args.reason);
      ctx.resolver.upsertChannel(guildId, { ...channel, permission_overwrites: others } as APIChannel);
      return {
        summary: `Removed the overwrite for ${args.target} on channel ${channelId}; it now inherits.`,
        data: { channel_id: channelId, target: args.target, target_id: target.id, allow: [], deny: [] },
      };
    }

    await ctx.rest.put(
      route,
      { type: target.type, allow: allowBits.toString(), deny: denyBits.toString() },
      args.reason,
    );
    const overwrite: APIOverwrite = {
      id: target.id,
      type: target.type,
      allow: allowBits.toString(),
      deny: denyBits.toString(),
    };
    ctx.resolver.upsertChannel(guildId, { ...channel, permission_overwrites: [...others, overwrite] } as APIChannel);

    const parts = [
      args.allow?.length ? `allowed ${args.allow.join(", ")}` : undefined,
      args.deny?.length ? `denied ${args.deny.join(", ")}` : undefined,
    ].filter(Boolean);

    return {
      summary: `On channel ${channelId}, ${args.target}: ${parts.join("; ")}.`,
      data: {
        channel_id: channelId,
        target: args.target,
        target_id: target.id,
        allow: permissionNames(allowBits),
        deny: permissionNames(denyBits),
      },
    };
  },
});

export const reorderChannels = defineTool({
  name: "discord_reorder_channels",
  title: "Reorder channels or categories",
  description:
    "Sets the top-to-bottom order of channels in one request.\n\n" +
    "Pass categories to order the categories, or channels that share one category to order those. Channels " +
    "left out keep their place; the listed ones fill the slots they occupied, in the order given.\n\n" +
    "Voice channels always render below text channels in a category - Discord's rule, not changeable here.",
  inputSchema: {
    guild: guildRef.optional(),
    order: z.array(channelRef).min(2).max(50).describe("Channels or categories, first one appears at the top."),
    reason: auditReason,
  },
  missingPermissionHint: "Needs the Manage Channels permission.",
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async handler(args, ctx) {
    const guildId = await ctx.resolver.guildId(args.guild);
    const [ids, channels] = await Promise.all([
      Promise.all(args.order.map((c) => ctx.resolver.channelId(c, guildId))),
      ctx.resolver.channels(guildId),
    ]);

    const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
    if (duplicate) {
      throw new ToolError(`Channel ${duplicate} appears more than once in order.`, {
        code: "DUPLICATE_CHANNEL",
        hint: "List each channel exactly once.",
      });
    }

    const byId = new Map(channels.map((c) => [c.id, c]));
    const chosen = ids.map((id) => byId.get(id));
    const missing = ids.filter((_, i) => chosen[i] === undefined);
    if (missing.length > 0) {
      throw new ToolError(`Not top-level channels of this server: ${missing.join(", ")}.`, {
        code: "NOT_FOUND",
        hint: "Threads cannot be reordered. Call discord_list_channels for valid channels.",
      });
    }

    const isCategory = (c: APIChannel | undefined): boolean => c?.type === ChannelType.GuildCategory;
    const categories = chosen.filter(isCategory).length;
    const parents = new Set(chosen.map((c) => (c ? parentOf(c) : null)));

    // Categories sort in their own scope, separately from the channels inside
    // them, and each category's children are a scope of their own, so a
    // mixed list would silently produce a nonsensical layout.
    if ((categories > 0 && categories < ids.length) || (categories === 0 && parents.size > 1)) {
      throw new ToolError("order mixes channels from different scopes.", {
        code: "MIXED_SCOPE",
        hint: "Order the categories in one call, then the channels inside each category in separate calls.",
      });
    }

    // Lay out the whole scope: unlisted siblings keep their slots, listed
    // ones fill the slots the listed set occupied, in the requested order.
    const parent = categories > 0 ? null : (parents.values().next().value ?? null);
    const siblings = channels
      .filter((c) => (categories > 0 ? isCategory(c) : !isCategory(c) && parentOf(c) === parent))
      .sort(displayOrder);
    const listed = new Set(ids);
    const queue = [...ids];
    const layout = siblings.map((c) => (listed.has(c.id) ? (queue.shift() as string) : c.id));

    const current = new Map(siblings.map((c) => [c.id, position(c)]));
    const changes = layout
      .map((id, index) => ({ id, position: index }))
      .filter((change) => current.get(change.id) !== change.position);

    if (changes.length > 0) await ctx.rest.patch(Routes.guildChannels(guildId), changes, args.reason);

    ctx.resolver.invalidateChannels(guildId);
    const noun = categories > 0 ? ["category", "categories"] : ["channel", "channels"];
    return {
      summary: `Reordered ${plural(ids.length, noun[0] as string, noun[1])}, top to bottom (${plural(changes.length, "position")} changed).`,
      // The real slot each channel landed in, which can differ from where it was listed.
      data: ids.map((id) => {
        const channel = byId.get(id);
        const name = channel && "name" in channel && channel.name ? channel.name : id;
        return { position: layout.indexOf(id), channel: name };
      }),
    };
  },
});
