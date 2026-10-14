import { z } from "zod";
import { Routes } from "discord-api-types/v10";
import type { APIGuild, APIGuildMember, APIInvite } from "discord-api-types/v10";
import { defineTool } from "./registry.js";
import type { ToolContext } from "./registry.js";
import { resolveChannel, plural } from "./util.js";
import { formatGuild, snowflakeToDate } from "../lib/format.js";
import { auditReason, channelRef, detail, guildRef } from "../schemas/common.js";
import { permissionNames } from "../schemas/permissions.js";

/** Servers whose bot permissions whoami reports; beyond this it would be noise. */
const WHOAMI_PERMISSION_GUILDS = 5;

/** The bot's effective server-wide permissions and top role in one guild. */
async function botStanding(
  ctx: ToolContext,
  guildId: string,
  selfId: string,
): Promise<{ top_role: string; permissions: string[] }> {
  const [member, roles] = await Promise.all([
    ctx.rest.get<APIGuildMember>(Routes.guildMember(guildId, selfId)),
    ctx.resolver.roles(guildId),
  ]);
  const held = roles.filter((r) => r.id === guildId || member.roles.includes(r.id));
  const bits = held.reduce((acc, r) => acc | BigInt(r.permissions), 0n);
  const top = held.reduce((a, b) => (b.position > a.position ? b : a), held[0] ?? { name: "@everyone", position: 0 });
  return { top_role: `${top.name} (position ${top.position})`, permissions: permissionNames(bits) };
}

export const listGuilds = defineTool({
  name: "discord_list_guilds",
  title: "List servers the bot is in",
  description:
    "Lists every server the bot has been invited to, with member counts.\n\n" +
    "Call this first when you are unsure which server to act on, or when another tool reports " +
    "that the `guild` argument is ambiguous.",
  inputSchema: { detail },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async handler(args, ctx) {
    const guilds = await ctx.resolver.guilds();

    if (guilds.length === 0) {
      return {
        summary:
          "The bot is not in any server yet. Invite it using the OAuth2 URL from the Developer Portal " +
          "(scopes: bot, applications.commands).",
        data: [],
      };
    }

    return {
      summary: `The bot is in ${plural(guilds.length, "server")}.`,
      data: guilds.map((g) => formatGuild(g, args.detail)),
    };
  },
});

export const getGuild = defineTool({
  name: "discord_get_guild",
  bulkArgs: ["guild"],
  title: "Get server details",
  description:
    "Returns an overview of one server: name, owner, member counts, creation date, enabled features, " +
    "and how many channels and roles it has.\n\n" +
    "Useful as a first orientation step before doing anything else in an unfamiliar server.",
  inputSchema: { guild: guildRef.optional(), detail },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async handler(args, ctx) {
    const guildId = await ctx.resolver.guildId(args.guild);

    const [guild, channels, roles] = await Promise.all([
      ctx.rest.get<APIGuild>(Routes.guild(guildId), { with_counts: true }),
      ctx.resolver.channels(guildId),
      ctx.resolver.roles(guildId),
    ]);

    const formatted = formatGuild(guild, args.detail);
    return {
      summary: `${guild.name} - ${formatted.member_count ?? "unknown"} members, ${channels.length} channels, ${roles.length} roles.`,
      data: {
        ...formatted,
        created_at: snowflakeToDate(guild.id),
        channel_count: channels.length,
        role_count: roles.length,
        online_count: guild.approximate_presence_count,
      },
    };
  },
});

export const createInvite = defineTool({
  name: "discord_create_invite",
  bulkArgs: ["channel"],
  missingPermissionHint:
    "Needs the Create Invite permission on that channel.",
  title: "Create an invite link",
  description:
    "Creates an invite link to a channel.\n\n" +
    "Defaults to a link that expires after 24 hours with unlimited uses, like Discord's own default. Set " +
    "`max_age_seconds` (0 = never expires) or `max_uses` to change that, or `temporary` to grant membership " +
    "only until the person disconnects.",
  inputSchema: {
    channel: channelRef,
    guild: guildRef.optional(),
    max_age_seconds: z
      .number()
      .int()
      .min(0)
      .max(604800)
      // A permanent public link outlives the conversation that asked for it, so
      // it has to be requested explicitly rather than be the default.
      .default(86400)
      .describe("Seconds until the invite expires (default 86400 = 24h); 0 means never (max 604800 = 7 days)."),
    max_uses: z.number().int().min(0).max(100).default(0).describe("Maximum uses; 0 means unlimited."),
    temporary: z.boolean().default(false).describe("Grant temporary membership only."),
    reason: auditReason,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async handler(args, ctx) {
    const channelId = await resolveChannel(ctx, args.channel, args.guild);

    const invite = await ctx.rest.post<APIInvite>(
      Routes.channelInvites(channelId),
      {
        max_age: args.max_age_seconds,
        max_uses: args.max_uses,
        temporary: args.temporary,
        unique: true,
      },
      args.reason,
    );

    const url = `https://discord.gg/${invite.code}`;
    return {
      summary: `Created invite ${url} for channel ${channelId}.`,
      data: {
        url,
        code: invite.code,
        expires_at: invite.expires_at ?? undefined,
        max_uses: args.max_uses === 0 ? "unlimited" : args.max_uses,
      },
    };
  },
});

export const whoAmI = defineTool({
  name: "discord_whoami",
  title: "Show the bot's own identity and setup",
  description:
    "Reports which bot account the token belongs to, which servers it can reach, and the safety settings: " +
    "destructive actions, @everyone pings and where files may be uploaded from.\n\n" +
    "Run this first to verify the server is configured correctly, or when a tool behaves unexpectedly.",
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async handler(_args, ctx) {
    const [me, guilds] = await Promise.all([ctx.resolver.self(), ctx.resolver.guilds()]);

    const standing = await Promise.all(
      guilds.slice(0, WHOAMI_PERMISSION_GUILDS).map((g) => botStanding(ctx, g.id, me.id).catch(() => undefined)),
    );

    return {
      summary: `Connected as ${me.username} (${me.id}), in ${plural(guilds.length, "server")}.`,
      data: {
        bot_username: me.username,
        bot_id: me.id,
        servers: guilds.map((g, i) => ({ id: g.id, name: g.name, ...(standing[i] ?? {}) })),
        destructive_actions_enabled: ctx.config.allowDestructive,
        mass_mentions_enabled: ctx.config.allowMassMentions,
        upload_dirs: ctx.config.uploadDirs ?? "anywhere",
        privileged_intents: ctx.config.privilegedIntents,
        default_guild: ctx.config.defaultGuild ?? null,
        gateway_connected: ctx.gateway.isConnected,
      },
    };
  },
});
