import { z } from "zod";
import { ChannelType, Routes } from "discord-api-types/v10";
import type { APIChannel, APIOverwrite, APIThreadChannel } from "discord-api-types/v10";
import { defineTool } from "./registry.js";
import type { ToolContext } from "./registry.js";
import { plural, resolveChannel, resolveGuildChannel, resolveOverwriteTarget } from "./util.js";
import { channelTypeName, formatChannel, THREAD_TYPES } from "../lib/format.js";
import type { CompactChannel } from "../lib/format.js";
import { ToolError } from "../lib/errors.js";
import { auditReason, channelRef, detail, guildRef, messageId } from "../schemas/common.js";
import { CHANNEL_PERMISSIONS, channelPermissionList, toBitfield } from "../schemas/permissions.js";
import type { ChannelPermission } from "../schemas/permissions.js";

/** Friendly names accepted by create/list, mapped to Discord's numeric types. */
const CREATABLE = {
  text: ChannelType.GuildText,
  voice: ChannelType.GuildVoice,
  category: ChannelType.GuildCategory,
  announcement: ChannelType.GuildAnnouncement,
  stage: ChannelType.GuildStageVoice,
  forum: ChannelType.GuildForum,
} as const;

const VOICE_TYPES = new Set<ChannelType>([ChannelType.GuildVoice, ChannelType.GuildStageVoice]);
const FORUM_TYPES = new Set<ChannelType>([ChannelType.GuildForum, ChannelType.GuildMedia]);

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
      .enum(["text", "voice", "category", "announcement", "stage", "forum", "all"])
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
      threadsByParent.set(key, [...(threadsByParent.get(key) ?? []), thread]);
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
    "Creates a text, voice, category, announcement, stage or forum channel.\n\n" +
    "Nest it with `category` (create the category first if needed). `permissions` sets overwrites in the same " +
    "request - e.g. a private staff channel: [{target:'@everyone', deny:['ViewChannel']}, " +
    "{target:'Moderator', allow:['ViewChannel']}]. Without `permissions` a channel inside a category inherits " +
    "the category's permissions.",
  inputSchema: {
    name: z.string().min(1).max(100).describe("Channel name. Discord lowercases and hyphenates text channel names."),
    guild: guildRef.optional(),
    type: z.enum(["text", "voice", "category", "announcement", "stage", "forum"]).default("text"),
    category: channelRef.optional().describe("Parent category to place this channel in."),
    topic: z.string().max(1024).optional().describe("Channel topic / description."),
    nsfw: z.boolean().optional(),
    slowmode_seconds: z.number().int().min(0).max(21600).optional().describe("Per-user rate limit, 0 to disable."),
    user_limit: z.number().int().min(0).max(99).optional().describe("Voice only: max members, 0 for unlimited."),
    position: z.number().int().min(0).optional(),
    permissions: z.array(overwriteSchema).max(50).optional().describe("Permission overwrites to apply on creation."),
    reason: auditReason,
  },
  missingPermissionHint:
    "Needs Manage Channels; setting permissions also needs Manage Roles, and the bot can only grant permissions it holds.",
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async handler(args, ctx) {
    const guildId = await ctx.resolver.guildId(args.guild);
    const [parentId, overwrites] = await Promise.all([
      args.category ? ctx.resolver.channelId(args.category, guildId) : undefined,
      args.permissions ? toOverwrites(ctx, guildId, args.permissions) : undefined,
    ]);

    // Discord only copies category permissions when none are given, so an
    // explicit list is layered on top of the category's own overwrites.
    let permissionOverwrites = overwrites;
    if (overwrites && parentId) {
      const parent = await ctx.resolver.findChannel(guildId, parentId);
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
    topic: z.string().max(1024).optional().describe("New topic; '' clears it."),
    nsfw: z.boolean().optional(),
    slowmode_seconds: z.number().int().min(0).max(21600).optional(),
    user_limit: z.number().int().min(0).max(99).optional(),
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

    const { guildId, channelId } = await resolveGuildChannel(ctx, args.channel, args.guild);
    const parentId =
      args.category === undefined
        ? undefined
        : args.category === null
          ? null
          : await ctx.resolver.channelId(args.category, guildId);

    const channel = await ctx.rest.patch<APIChannel>(
      Routes.channel(channelId),
      {
        name: args.name,
        topic: args.topic,
        nsfw: args.nsfw,
        rate_limit_per_user: args.slowmode_seconds,
        user_limit: args.user_limit,
        position: args.position,
        parent_id: parentId,
        lock_permissions: args.sync_permissions,
      },
      args.reason,
    );

    ctx.resolver.upsertChannel(guildId, channel);
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
    const { guildId, channelId } = await resolveGuildChannel(ctx, args.channel, args.guild);
    const deleted = await ctx.rest.delete<APIChannel>(Routes.channel(channelId), args.reason);

    ctx.resolver.removeChannel(guildId, channelId);
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

      // Text-channel threads start empty; post the opening message into them.
      if (!isForum && args.content) {
        await ctx.rest.post(Routes.channelMessages(thread.id), {
          content: args.content,
          allowed_mentions: { parse: [] },
        });
      }

      return {
        summary: `Created ${isForum ? "forum post" : "thread"} "${args.name}" (${thread.id}).`,
        data: formatChannel(thread),
      };
    }

    const channelId = await resolveChannel(ctx, args.channel, args.guild);
    const state = {
      archive: { archived: true },
      unarchive: { archived: false },
      lock: { locked: true },
      unlock: { locked: false },
    }[args.action];

    const thread = await ctx.rest.patch<APIThreadChannel>(Routes.channel(channelId), state, args.reason);
    return { summary: `Thread ${channelId}: ${args.action} applied.`, data: formatChannel(thread) };
  },
});

/** Decodes an overwrite bitfield back into the curated channel permission names. */
function channelPermissionNames(bits: string): ChannelPermission[] {
  const value = BigInt(bits);
  return (Object.keys(CHANNEL_PERMISSIONS) as ChannelPermission[]).filter(
    (name) => (value & CHANNEL_PERMISSIONS[name]) !== 0n,
  );
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

    if (args.mode === "reset") {
      await ctx.rest.delete(route, args.reason);
      ctx.resolver.invalidateChannels(guildId);
      return {
        summary: `Removed the overwrite for ${args.target} on channel ${channelId}; it now inherits.`,
        data: { channel_id: channelId, target: args.target, target_id: target.id, allow: [], deny: [] },
      };
    }

    let allow = new Set<ChannelPermission>(args.allow ?? []);
    let deny = new Set<ChannelPermission>(args.deny ?? []);

    if (args.mode === "merge") {
      const channel = await ctx.rest.get<APIChannel>(Routes.channel(channelId));
      const existing =
        "permission_overwrites" in channel ? channel.permission_overwrites?.find((o) => o.id === target.id) : undefined;
      if (existing) {
        // Anything newly allowed stops being denied, and vice versa.
        const keptAllow = channelPermissionNames(existing.allow).filter((p) => !deny.has(p));
        const keptDeny = channelPermissionNames(existing.deny).filter((p) => !allow.has(p));
        allow = new Set([...keptAllow, ...allow]);
        deny = new Set([...keptDeny, ...deny]);
      }
    }

    await ctx.rest.put(
      route,
      { type: target.type, allow: toBitfield([...allow]), deny: toBitfield([...deny]) },
      args.reason,
    );
    ctx.resolver.invalidateChannels(guildId);

    const parts = [
      args.allow?.length ? `allowed ${args.allow.join(", ")}` : undefined,
      args.deny?.length ? `denied ${args.deny.join(", ")}` : undefined,
    ].filter(Boolean);

    return {
      summary: `On channel ${channelId}, ${args.target}: ${parts.join("; ")}.`,
      data: { channel_id: channelId, target: args.target, target_id: target.id, allow: [...allow], deny: [...deny] },
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
      data: args.order.map((name, index) => ({ position: index, channel: name })),
    };
  },
});
