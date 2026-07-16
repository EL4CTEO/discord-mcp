#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  Client, GatewayIntentBits, ChannelType, PermissionsBitField, AuditLogEvent, ActivityType,
  AutoModerationRuleTriggerType, AutoModerationRuleEventType, AutoModerationActionType,
  AutoModerationRuleKeywordPresetType,
} from "discord.js";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, ".discord-mcp-config.json");
const MAX_RESPONSE_CHARS = 25000;

function loadConfig() {
  if (existsSync(CONFIG_PATH)) {
    try { return JSON.parse(readFileSync(CONFIG_PATH, "utf8")); } catch {}
  }
  return {};
}

function saveConfig(config) {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
if (!BOT_TOKEN) {
  process.stderr.write("DISCORD_BOT_TOKEN environment variable is required\n");
  process.exit(1);
}

const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildInvites,
    GatewayIntentBits.GuildWebhooks,
  ],
});

const discordReady = new Promise((resolve, reject) => {
  discord.once("ready", resolve);
  discord.once("error", reject);
  discord.login(BOT_TOKEN).catch(reject);
});
discordReady.catch(() => {}); // surfaced per-call when awaited; prevents an unhandled-rejection crash at startup

// ---------- resolvers ----------

const ID_RE = /^\d{17,20}$/;

function resolveGuild(args) {
  const id = args.guild_id || loadConfig().default_guild_id;
  if (!id) throw new Error("No guild_id provided and no default guild set. Run guild with action=set_default first.");
  const guild = discord.guilds.cache.get(id);
  if (!guild) throw new Error(`Guild ${id} not found or bot is not in this server. Run guild with action=list to see available servers.`);
  return guild;
}

async function resolveChannel(guild, ref, { textOnly = false } = {}) {
  if (!ref) throw new Error("Missing 'channel' parameter (channel ID, channel name, or thread ID).");
  let channel = guild.channels.cache.get(ref);
  if (!channel && ID_RE.test(ref)) {
    try { channel = await discord.channels.fetch(ref); } catch {}
  }
  if (!channel) {
    const lower = ref.toLowerCase();
    channel = guild.channels.cache.find((c) => c.name && c.name.toLowerCase() === lower);
  }
  if (!channel) {
    const active = await guild.channels.fetchActiveThreads();
    channel = active.threads.get(ref);
    if (!channel) {
      const lower = ref.toLowerCase();
      channel = active.threads.find((t) => t.name.toLowerCase() === lower);
    }
  }
  if (!channel) throw new Error(`Channel or thread "${ref}" not found. Run channel with action=list to see all channels.`);
  if (textOnly && !channel.isTextBased()) throw new Error(`Channel "${channel.name}" is not text-based.`);
  return channel;
}

async function resolveMember(guild, ref) {
  if (!ref) throw new Error("Missing 'user' parameter (user ID or username).");
  if (ID_RE.test(ref)) return await guild.members.fetch(ref);
  await guild.members.fetch();
  const lower = ref.toLowerCase();
  const member = guild.members.cache.find(
    (m) =>
      m.user.username.toLowerCase() === lower ||
      m.displayName.toLowerCase() === lower ||
      (m.user.globalName && m.user.globalName.toLowerCase() === lower)
  );
  if (!member) throw new Error(`User "${ref}" not found in this server.`);
  return member;
}

function resolveRole(guild, ref) {
  if (!ref) throw new Error("Missing 'role' parameter (role ID or name).");
  if (ID_RE.test(ref)) {
    const role = guild.roles.cache.get(ref);
    if (!role) throw new Error(`Role ${ref} not found.`);
    return role;
  }
  const lower = ref.toLowerCase();
  const role = guild.roles.cache.find((r) => r.name.toLowerCase() === lower);
  if (!role) throw new Error(`Role "${ref}" not found. Run role with action=list to see all roles.`);
  return role;
}

function permissionFlags(names) {
  return (names || []).map((p) => {
    if (PermissionsBitField.Flags[p] === undefined) {
      throw new Error(`Unknown permission "${p}". Use discord.js flag names like SendMessages, ViewChannel, ManageMessages, Administrator.`);
    }
    return PermissionsBitField.Flags[p];
  });
}

// ---------- payload / formatting helpers ----------

function buildMessagePayload(args) {
  const payload = {};
  if (args.content) payload.content = args.content;
  if (args.embed) {
    const e = args.embed;
    const built = {};
    if (e.title) built.title = e.title;
    if (e.description) built.description = e.description;
    if (e.color !== undefined) built.color = typeof e.color === "string" ? parseInt(e.color.replace("#", ""), 16) : e.color;
    if (e.url) built.url = e.url;
    if (e.thumbnail) built.thumbnail = { url: e.thumbnail };
    if (e.image) built.image = { url: e.image };
    if (e.footer) built.footer = typeof e.footer === "string" ? { text: e.footer } : e.footer;
    if (e.author) built.author = typeof e.author === "string" ? { name: e.author } : e.author;
    if (e.fields) built.fields = e.fields;
    if (e.timestamp) built.timestamp = e.timestamp === true ? new Date().toISOString() : e.timestamp;
    payload.embeds = [built];
  }
  if (!payload.content && !payload.embeds) throw new Error("Either 'content' or 'embed' is required.");
  return payload;
}

function mapMessage(m, { detailed = false } = {}) {
  const out = {
    id: m.id,
    author: m.author.username,
    author_id: m.author.id,
    content: m.content,
    timestamp: m.createdAt,
  };
  if (m.author.bot) out.is_bot = true;
  if (m.editedAt) out.edited = true;
  if (m.attachments.size) {
    out.attachments = [...m.attachments.values()].map((a) =>
      detailed
        ? { name: a.name, url: a.url, size: a.size, content_type: a.contentType, width: a.width, height: a.height }
        : { name: a.name, url: a.url, size: a.size }
    );
  }
  if (m.embeds.length) {
    out.embeds = m.embeds.map((e) => ({
      title: e.title, description: e.description?.slice(0, 300), url: e.url,
      image: e.image?.url, thumbnail: e.thumbnail?.url,
    }));
  }
  if (m.reactions.cache.size) {
    out.reactions = [...m.reactions.cache.values()].map((r) => ({ emoji: r.emoji.toString(), count: r.count }));
  }
  if (detailed) {
    out.display_name = m.member?.displayName || m.author.username;
    out.pinned = m.pinned;
    out.url = m.url;
    if (m.reference?.messageId) out.replied_to = m.reference.messageId;
  }
  return out;
}

const CHANNEL_TYPE_NAMES = {
  [ChannelType.GuildText]: "text",
  [ChannelType.GuildVoice]: "voice",
  [ChannelType.GuildCategory]: "category",
  [ChannelType.GuildAnnouncement]: "announcement",
  [ChannelType.GuildForum]: "forum",
  [ChannelType.GuildStageVoice]: "stage",
  [ChannelType.PublicThread]: "thread",
  [ChannelType.PrivateThread]: "private_thread",
  [ChannelType.AnnouncementThread]: "announcement_thread",
};

function channelTypeName(type) {
  return CHANNEL_TYPE_NAMES[type] || `type_${type}`;
}

const CREATE_CHANNEL_TYPES = {
  text: ChannelType.GuildText,
  voice: ChannelType.GuildVoice,
  category: ChannelType.GuildCategory,
  announcement: ChannelType.GuildAnnouncement,
  forum: ChannelType.GuildForum,
  stage: ChannelType.GuildStageVoice,
};

const ACTIVITY_TYPES = {
  playing: ActivityType.Playing,
  streaming: ActivityType.Streaming,
  listening: ActivityType.Listening,
  watching: ActivityType.Watching,
  competing: ActivityType.Competing,
  custom: ActivityType.Custom,
};

const AUDIT_LOG_ACTIONS = {
  member_kick: AuditLogEvent.MemberKick,
  member_ban: AuditLogEvent.MemberBanAdd,
  member_unban: AuditLogEvent.MemberBanRemove,
  member_update: AuditLogEvent.MemberUpdate,
  member_role_update: AuditLogEvent.MemberRoleUpdate,
  channel_create: AuditLogEvent.ChannelCreate,
  channel_update: AuditLogEvent.ChannelUpdate,
  channel_delete: AuditLogEvent.ChannelDelete,
  role_create: AuditLogEvent.RoleCreate,
  role_update: AuditLogEvent.RoleUpdate,
  role_delete: AuditLogEvent.RoleDelete,
  message_delete: AuditLogEvent.MessageDelete,
  message_bulk_delete: AuditLogEvent.MessageBulkDelete,
  invite_create: AuditLogEvent.InviteCreate,
  webhook_create: AuditLogEvent.WebhookCreate,
  guild_update: AuditLogEvent.GuildUpdate,
};

function requireArgs(args, names) {
  for (const n of names) {
    if (args[n] === undefined || args[n] === null || args[n] === "") {
      throw new Error(`Missing required parameter '${n}' for action '${args.action}'.`);
    }
  }
}

function unknownAction(tool, action, actions) {
  return new Error(`Unknown action "${action}" for tool '${tool}'. Valid actions: ${actions.join(", ")}.`);
}

// ---------- tool definitions ----------

const GUILD_ID_PROP = { guild_id: { type: "string", description: "Server ID. Omit to use the default guild." } };
const CHANNEL_PROP = { channel: { type: "string", description: "Channel ID, channel name, or thread ID" } };
const EMBED_PROP = {
  embed: {
    type: "object",
    description: "Rich embed. All fields optional.",
    properties: {
      title: { type: "string" }, description: { type: "string" },
      color: { type: "string", description: "Hex color like #5865F2" },
      url: { type: "string" }, image: { type: "string" }, thumbnail: { type: "string" },
      footer: { type: "string" }, author: { type: "string" },
      fields: { type: "array", items: { type: "object", properties: { name: { type: "string" }, value: { type: "string" }, inline: { type: "boolean" } } } },
      timestamp: { type: "boolean" },
    },
  },
};

const tools = [
  {
    name: "guild",
    description: "Manage servers. Actions: set_default (persist a default server ID so other tools don't need guild_id), list (servers the bot is in), info (details of one server), edit (name/description/icon/banner/system channels).",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["set_default", "list", "info", "edit"] },
        ...GUILD_ID_PROP,
        name: { type: "string" }, description: { type: "string" },
        icon: { type: "string", description: "Image URL" }, banner: { type: "string", description: "Image URL" },
        system_channel: { type: "string" }, rules_channel: { type: "string" },
        afk_channel: { type: "string" }, afk_timeout: { type: "number", description: "Seconds: 60, 300, 900, 1800 or 3600" },
      },
      required: ["action"],
    },
    annotations: { openWorldHint: true },
  },
  {
    name: "channel",
    description: "Manage channels and categories. Actions: list (all channels with IDs — use this to resolve names to IDs), info (one channel, includes forum tags and permission overwrites), create, edit (name/topic/nsfw/slowmode/bitrate/user_limit/category/position/forum_tags), clone, delete, set_permissions (per-role or per-user overwrites).",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "info", "create", "edit", "clone", "delete", "set_permissions"] },
        ...GUILD_ID_PROP,
        ...CHANNEL_PROP,
        type: { type: "string", enum: ["text", "voice", "category", "announcement", "forum", "stage"], description: "For create. Default text." },
        name: { type: "string" }, topic: { type: "string" }, nsfw: { type: "boolean" },
        slowmode: { type: "number", description: "Seconds between messages per user" },
        bitrate: { type: "number" }, user_limit: { type: "number" }, position: { type: "number" },
        category: { type: "string", description: "Parent category ID or name. Empty string removes the category." },
        forum_tags: { type: "array", description: "For forum channels: replaces available tags", items: { type: "object", properties: { name: { type: "string" }, emoji: { type: "string" }, moderated: { type: "boolean" } }, required: ["name"] } },
        target: { type: "string", description: "For set_permissions: role or user ID" },
        allow: { type: "array", items: { type: "string" }, description: "Permission flags to allow, e.g. ViewChannel, SendMessages" },
        deny: { type: "array", items: { type: "string" }, description: "Permission flags to deny" },
        reason: { type: "string" },
      },
      required: ["action"],
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  {
    name: "read_messages",
    description: "Read channel/thread messages. Actions: fetch (recent messages, paginate with before/after), get (one message with full detail incl. attachments, reactions and jump URL), search (substring search over recent messages), pinned (pinned messages), reactions (who reacted with a given emoji).",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["fetch", "get", "search", "pinned", "reactions"] },
        ...GUILD_ID_PROP,
        ...CHANNEL_PROP,
        message_id: { type: "string" },
        query: { type: "string", description: "For search: case-insensitive substring" },
        emoji: { type: "string", description: "For reactions" },
        limit: { type: "number", description: "Max messages (default 20 for fetch, 100 for search; cap 100)" },
        before: { type: "string", description: "Message ID: fetch messages older than this" },
        after: { type: "string", description: "Message ID: fetch messages newer than this" },
      },
      required: ["action", "channel"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "send_message",
    description: "Write messages in a channel or thread. Actions: send (text and/or embed), reply (to message_id; ping=false to avoid pinging the author), edit (own message by message_id), poll (question + answers).",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["send", "reply", "edit", "poll"] },
        ...GUILD_ID_PROP,
        ...CHANNEL_PROP,
        content: { type: "string" },
        ...EMBED_PROP,
        message_id: { type: "string", description: "For reply/edit" },
        ping: { type: "boolean", description: "For reply: ping the replied user (default true)" },
        poll: { type: "object", properties: { question: { type: "string" }, answers: { type: "array", items: { type: "string" }, description: "2-10 options" }, duration_hours: { type: "number", description: "Default 24" }, multi_select: { type: "boolean" } }, required: ["question", "answers"] },
      },
      required: ["action", "channel"],
    },
    annotations: { openWorldHint: true },
  },
  {
    name: "manage_message",
    description: "Moderate existing messages. Actions: pin, unpin, delete, bulk_delete (up to 100 message_ids, younger than 14 days), react (add emoji), unreact (remove own reaction).",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["pin", "unpin", "delete", "bulk_delete", "react", "unreact"] },
        ...GUILD_ID_PROP,
        ...CHANNEL_PROP,
        message_id: { type: "string" },
        message_ids: { type: "array", items: { type: "string" }, description: "For bulk_delete" },
        emoji: { type: "string", description: "For react/unreact: unicode emoji or custom emoji like <:name:id>" },
      },
      required: ["action", "channel"],
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  {
    name: "dm",
    description: "Direct messages. Actions: send, reply, edit, delete, history. 'user' accepts a user ID or a username (username lookup uses the default guild's members).",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["send", "reply", "edit", "delete", "history"] },
        ...GUILD_ID_PROP,
        user: { type: "string", description: "User ID or username" },
        content: { type: "string" },
        ...EMBED_PROP,
        message_id: { type: "string", description: "For reply/edit/delete" },
        limit: { type: "number", description: "For history (default 20, cap 100)" },
        before: { type: "string", description: "For history: message ID to paginate back from" },
      },
      required: ["action", "user"],
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  {
    name: "thread",
    description: "Threads and forum posts. Actions: create (in a text channel, from a message via message_id, or in a forum channel — forum posts require content and accept tags by name), list (active threads, optionally filtered by parent channel), edit (rename, archive, lock). Send/read thread messages with send_message/read_messages using the thread ID as 'channel'.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "list", "edit"] },
        ...GUILD_ID_PROP,
        channel: { type: "string", description: "Parent channel (create/list) or thread ID (edit)" },
        name: { type: "string" },
        message_id: { type: "string", description: "For create: start the thread from this message" },
        content: { type: "string", description: "Initial message (required for forum posts)" },
        ...EMBED_PROP,
        tags: { type: "array", items: { type: "string" }, description: "For forum posts: tag names to apply" },
        auto_archive_minutes: { type: "number", enum: [60, 1440, 4320, 10080], description: "Default 1440" },
        archived: { type: "boolean" }, locked: { type: "boolean" },
      },
      required: ["action"],
    },
    annotations: { openWorldHint: true },
  },
  {
    name: "role",
    description: "Manage roles. Actions: list, create, edit, delete, assign (give role to user), remove (take role from user). 'role' and 'user' accept IDs or names.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "create", "edit", "delete", "assign", "remove"] },
        ...GUILD_ID_PROP,
        role: { type: "string", description: "Role ID or name" },
        user: { type: "string", description: "User ID or username (assign/remove)" },
        name: { type: "string" }, color: { type: "string", description: "Hex like #FF0000" },
        hoist: { type: "boolean" }, mentionable: { type: "boolean" },
        permissions: { type: "array", items: { type: "string" }, description: "Permission flags, e.g. ManageMessages, KickMembers" },
        reason: { type: "string" },
      },
      required: ["action"],
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  {
    name: "member",
    description: "Server members. Actions: list (optionally filter by role), get (profile, roles, join date), edit (nickname and/or add_roles/remove_roles in one call), prune (kick members inactive for N days; dry_run=true by default — set dry_run=false to actually prune).",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "get", "edit", "prune"] },
        ...GUILD_ID_PROP,
        user: { type: "string", description: "User ID or username" },
        role: { type: "string", description: "For list: only members with this role" },
        limit: { type: "number", description: "For list (default 100, cap 1000)" },
        nickname: { type: "string", description: "For edit. Empty string clears it." },
        add_roles: { type: "array", items: { type: "string" } },
        remove_roles: { type: "array", items: { type: "string" } },
        days: { type: "number", description: "For prune: inactivity threshold (default 7)" },
        dry_run: { type: "boolean", description: "For prune: only count, don't kick (default true)" },
        reason: { type: "string" },
      },
      required: ["action"],
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  {
    name: "moderate",
    description: "Moderation. Actions: kick, ban (delete_message_days 0-7), unban, timeout (duration_minutes, max 40320), remove_timeout, list_bans, audit_log (recent audit entries, filter by audit_action and/or user).",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["kick", "ban", "unban", "timeout", "remove_timeout", "list_bans", "audit_log"] },
        ...GUILD_ID_PROP,
        user: { type: "string", description: "User ID or username (unban requires the ID)" },
        reason: { type: "string" },
        delete_message_days: { type: "number", description: "For ban: purge this many days of messages (0-7)" },
        duration_minutes: { type: "number", description: "For timeout" },
        limit: { type: "number", description: "For list_bans/audit_log (default 20-100)" },
        audit_action: { type: "string", enum: Object.keys(AUDIT_LOG_ACTIONS), description: "For audit_log" },
      },
      required: ["action"],
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  {
    name: "invite",
    description: "Invites. Actions: create (for a channel; max_age_seconds 0 = never expires, max_uses 0 = unlimited), list, delete (by code).",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "list", "delete"] },
        ...GUILD_ID_PROP,
        ...CHANNEL_PROP,
        code: { type: "string", description: "For delete" },
        max_age_seconds: { type: "number", description: "Default 86400 (24h)" },
        max_uses: { type: "number" }, temporary: { type: "boolean" }, unique: { type: "boolean" },
      },
      required: ["action"],
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  {
    name: "webhook",
    description: "Webhooks. Actions: create (in a channel; returns the webhook URL), list (all in guild or one channel), delete (by webhook_id), send (post via webhook_url with optional username/avatar_url override).",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "list", "delete", "send"] },
        ...GUILD_ID_PROP,
        ...CHANNEL_PROP,
        name: { type: "string" },
        webhook_id: { type: "string", description: "For delete" },
        webhook_url: { type: "string", description: "For send" },
        content: { type: "string" },
        ...EMBED_PROP,
        username: { type: "string", description: "For send: display name override" },
        avatar_url: { type: "string", description: "Avatar image URL (create or send override)" },
      },
      required: ["action"],
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  {
    name: "automod",
    description: "AutoMod rules. Actions: list, create, edit, delete. Triggers: keyword (keywords/regex_patterns/allow_list), spam, keyword_preset (presets: profanity, sexual_content, slurs), mention_spam (mention_limit). Responses: block message, alert to a channel, timeout.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "create", "edit", "delete"] },
        ...GUILD_ID_PROP,
        rule_id: { type: "string", description: "For edit/delete" },
        name: { type: "string" },
        trigger: { type: "string", enum: ["keyword", "spam", "keyword_preset", "mention_spam"], description: "For create" },
        keywords: { type: "array", items: { type: "string" } },
        regex_patterns: { type: "array", items: { type: "string" } },
        presets: { type: "array", items: { type: "string", enum: ["profanity", "sexual_content", "slurs"] } },
        allow_list: { type: "array", items: { type: "string" } },
        mention_limit: { type: "number" },
        block_message: { type: "boolean", description: "Block matching messages (default true on create)" },
        alert_channel: { type: "string", description: "Channel to send alerts to" },
        timeout_seconds: { type: "number", description: "Timeout offenders for this long" },
        enabled: { type: "boolean" },
        exempt_roles: { type: "array", items: { type: "string" } },
        exempt_channels: { type: "array", items: { type: "string" } },
      },
      required: ["action"],
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  {
    name: "bot",
    description: "The bot itself. Actions: info (identity, uptime, ping, server count), set_status (online/idle/dnd/invisible plus optional activity like 'watching the server').",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["info", "set_status"] },
        status: { type: "string", enum: ["online", "idle", "dnd", "invisible"] },
        activity_type: { type: "string", enum: Object.keys(ACTIVITY_TYPES) },
        activity_name: { type: "string" },
        activity_url: { type: "string", description: "Only for streaming" },
      },
      required: ["action"],
    },
    annotations: { openWorldHint: true },
  },
];

// ---------- handlers ----------

const handlers = {

  async guild(args) {
    switch (args.action) {
      case "set_default": {
        requireArgs(args, ["guild_id"]);
        const guild = discord.guilds.cache.get(args.guild_id);
        if (!guild) throw new Error(`Guild ${args.guild_id} not found. Run guild with action=list to see available servers.`);
        const config = loadConfig();
        config.default_guild_id = args.guild_id;
        saveConfig(config);
        return { default_guild_id: args.guild_id, guild_name: guild.name, persisted: true };
      }
      case "list": {
        const config = loadConfig();
        return {
          default_guild_id: config.default_guild_id || null,
          guilds: discord.guilds.cache.map((g) => ({
            id: g.id, name: g.name, member_count: g.memberCount,
            ...(g.id === config.default_guild_id && { is_default: true }),
          })),
        };
      }
      case "info": {
        const g = resolveGuild(args);
        return {
          id: g.id, name: g.name, description: g.description,
          icon_url: g.iconURL({ size: 1024 }), banner_url: g.bannerURL({ size: 1024 }),
          owner_id: g.ownerId, member_count: g.memberCount, created_at: g.createdAt,
          verification_level: g.verificationLevel, premium_tier: g.premiumTier,
          boosts: g.premiumSubscriptionCount, locale: g.preferredLocale,
          system_channel_id: g.systemChannelId, rules_channel_id: g.rulesChannelId,
          afk_channel_id: g.afkChannelId, afk_timeout: g.afkTimeout,
          vanity_code: g.vanityURLCode, features: g.features,
        };
      }
      case "edit": {
        const g = resolveGuild(args);
        const edits = {};
        if (args.name !== undefined) edits.name = args.name;
        if (args.description !== undefined) edits.description = args.description;
        if (args.icon !== undefined) edits.icon = args.icon;
        if (args.banner !== undefined) edits.banner = args.banner;
        if (args.system_channel !== undefined) edits.systemChannel = args.system_channel || null;
        if (args.rules_channel !== undefined) edits.rulesChannel = args.rules_channel || null;
        if (args.afk_channel !== undefined) edits.afkChannel = args.afk_channel || null;
        if (args.afk_timeout !== undefined) edits.afkTimeout = args.afk_timeout;
        if (!Object.keys(edits).length) throw new Error("No properties to edit were provided.");
        await g.edit(edits);
        return { id: g.id, edited: Object.keys(edits) };
      }
      default: throw unknownAction("guild", args.action, ["set_default", "list", "info", "edit"]);
    }
  },

  async channel(args) {
    const guild = resolveGuild(args);
    switch (args.action) {
      case "list": {
        return {
          guild_id: guild.id,
          channels: [...guild.channels.cache.values()]
            .sort((a, b) => (a.rawPosition || 0) - (b.rawPosition || 0))
            .map((c) => ({
              id: c.id, name: c.name, type: channelTypeName(c.type),
              ...(c.parentId && { category_id: c.parentId }),
              ...(c.topic && { topic: c.topic.slice(0, 100) }),
            })),
        };
      }
      case "info": {
        const ch = await resolveChannel(guild, args.channel);
        const info = {
          id: ch.id, name: ch.name, type: channelTypeName(ch.type),
          category_id: ch.parentId, position: ch.rawPosition, created_at: ch.createdAt,
        };
        if (ch.topic) info.topic = ch.topic;
        if (ch.nsfw !== undefined) info.nsfw = ch.nsfw;
        if (ch.rateLimitPerUser) info.slowmode = ch.rateLimitPerUser;
        if (ch.bitrate) info.bitrate = ch.bitrate;
        if (ch.userLimit !== undefined) info.user_limit = ch.userLimit;
        if (ch.type === ChannelType.GuildForum) {
          info.forum_tags = ch.availableTags.map((t) => ({ id: t.id, name: t.name, emoji: t.emoji?.name, moderated: t.moderated }));
        }
        if (ch.permissionOverwrites) {
          info.permission_overwrites = [...ch.permissionOverwrites.cache.values()].map((o) => ({
            target_id: o.id,
            target: guild.roles.cache.get(o.id)?.name || guild.members.cache.get(o.id)?.user.username || "unknown",
            type: o.type === 0 ? "role" : "member",
            allow: o.allow.toArray(), deny: o.deny.toArray(),
          }));
        }
        return info;
      }
      case "create": {
        requireArgs(args, ["name"]);
        const type = CREATE_CHANNEL_TYPES[args.type || "text"];
        if (type === undefined) throw new Error(`Unknown channel type "${args.type}". Use: ${Object.keys(CREATE_CHANNEL_TYPES).join(", ")}.`);
        const opts = { name: args.name, type };
        if (args.category) opts.parent = (await resolveChannel(guild, args.category)).id;
        if (args.topic) opts.topic = args.topic;
        if (args.nsfw) opts.nsfw = true;
        if (args.slowmode) opts.rateLimitPerUser = args.slowmode;
        if (args.bitrate) opts.bitrate = args.bitrate;
        if (args.user_limit) opts.userLimit = args.user_limit;
        const ch = await guild.channels.create(opts);
        return { id: ch.id, name: ch.name, type: channelTypeName(ch.type) };
      }
      case "edit": {
        const ch = await resolveChannel(guild, args.channel);
        const edits = {};
        if (args.name !== undefined) edits.name = args.name;
        if (args.topic !== undefined) edits.topic = args.topic;
        if (args.nsfw !== undefined) edits.nsfw = args.nsfw;
        if (args.slowmode !== undefined) edits.rateLimitPerUser = args.slowmode;
        if (args.bitrate !== undefined) edits.bitrate = args.bitrate;
        if (args.user_limit !== undefined) edits.userLimit = args.user_limit;
        if (args.position !== undefined) edits.position = args.position;
        if (args.category !== undefined) edits.parent = args.category ? (await resolveChannel(guild, args.category)).id : null;
        if (args.forum_tags !== undefined) {
          if (ch.type !== ChannelType.GuildForum) throw new Error(`"${ch.name}" is not a forum channel; forum_tags only applies to forums.`);
          edits.availableTags = args.forum_tags.map((t) => ({
            name: t.name, moderated: t.moderated || false,
            ...(t.emoji && { emoji: { name: t.emoji } }),
          }));
        }
        if (!Object.keys(edits).length) throw new Error("No properties to edit were provided.");
        await ch.edit({ ...edits, reason: args.reason });
        return { id: ch.id, name: ch.name, edited: Object.keys(edits) };
      }
      case "clone": {
        const ch = await resolveChannel(guild, args.channel);
        const cloned = await ch.clone({ name: args.name || `${ch.name}-clone` });
        return { id: cloned.id, name: cloned.name, cloned_from: ch.id };
      }
      case "delete": {
        const ch = await resolveChannel(guild, args.channel);
        const name = ch.name;
        await ch.delete(args.reason || undefined);
        return { deleted: ch.id, name };
      }
      case "set_permissions": {
        requireArgs(args, ["target"]);
        const ch = await resolveChannel(guild, args.channel);
        permissionFlags(args.allow);
        permissionFlags(args.deny);
        const overwrites = {};
        for (const p of args.allow || []) overwrites[p] = true;
        for (const p of args.deny || []) overwrites[p] = false;
        if (!Object.keys(overwrites).length) throw new Error("Provide 'allow' and/or 'deny' permission lists.");
        await ch.permissionOverwrites.edit(args.target, overwrites, { reason: args.reason });
        return { channel_id: ch.id, target: args.target, allowed: args.allow || [], denied: args.deny || [] };
      }
      default: throw unknownAction("channel", args.action, ["list", "info", "create", "edit", "clone", "delete", "set_permissions"]);
    }
  },

  async read_messages(args) {
    const guild = resolveGuild(args);
    const channel = await resolveChannel(guild, args.channel, { textOnly: true });
    switch (args.action) {
      case "fetch": {
        const limit = Math.min(args.limit || 20, 100);
        const opts = { limit };
        if (args.before) opts.before = args.before;
        if (args.after) opts.after = args.after;
        const messages = await channel.messages.fetch(opts);
        return {
          channel_id: channel.id, channel_name: channel.name,
          messages: [...messages.values()].reverse().map((m) => mapMessage(m)),
        };
      }
      case "get": {
        requireArgs(args, ["message_id"]);
        const m = await channel.messages.fetch(args.message_id);
        return mapMessage(m, { detailed: true });
      }
      case "search": {
        requireArgs(args, ["query"]);
        const limit = Math.min(args.limit || 100, 100);
        const messages = await channel.messages.fetch({ limit });
        const lower = args.query.toLowerCase();
        const matches = [...messages.values()].filter((m) => m.content.toLowerCase().includes(lower));
        return {
          channel_id: channel.id, query: args.query,
          scanned: messages.size, match_count: matches.length,
          matches: matches.map((m) => mapMessage(m)),
        };
      }
      case "pinned": {
        const pinned = await channel.messages.fetchPinned();
        return { channel_id: channel.id, count: pinned.size, messages: [...pinned.values()].map((m) => mapMessage(m)) };
      }
      case "reactions": {
        requireArgs(args, ["message_id", "emoji"]);
        const m = await channel.messages.fetch(args.message_id);
        const reaction = m.reactions.cache.find((r) => r.emoji.toString() === args.emoji || r.emoji.name === args.emoji);
        if (!reaction) return { emoji: args.emoji, count: 0, users: [] };
        const users = await reaction.users.fetch({ limit: Math.min(args.limit || 100, 100) });
        return { emoji: reaction.emoji.toString(), count: reaction.count, users: [...users.values()].map((u) => ({ id: u.id, username: u.username })) };
      }
      default: throw unknownAction("read_messages", args.action, ["fetch", "get", "search", "pinned", "reactions"]);
    }
  },

  async send_message(args) {
    const guild = resolveGuild(args);
    const channel = await resolveChannel(guild, args.channel, { textOnly: true });
    switch (args.action) {
      case "send": {
        const msg = await channel.send(buildMessagePayload(args));
        return { message_id: msg.id, channel_id: channel.id, url: msg.url };
      }
      case "reply": {
        requireArgs(args, ["message_id"]);
        const target = await channel.messages.fetch(args.message_id);
        const payload = { ...buildMessagePayload(args), allowedMentions: { repliedUser: args.ping !== false } };
        const msg = await target.reply(payload);
        return { message_id: msg.id, channel_id: channel.id, replied_to: args.message_id };
      }
      case "edit": {
        requireArgs(args, ["message_id"]);
        const msg = await channel.messages.fetch(args.message_id);
        await msg.edit(buildMessagePayload(args));
        return { edited: args.message_id, channel_id: channel.id };
      }
      case "poll": {
        requireArgs(args, ["poll"]);
        const p = args.poll;
        if (!p.question || !p.answers?.length) throw new Error("poll requires 'question' and 'answers'.");
        const msg = await channel.send({
          poll: {
            question: { text: p.question },
            answers: p.answers.slice(0, 10).map((a) => ({ text: a })),
            duration: p.duration_hours || 24,
            allowMultiselect: p.multi_select || false,
          },
        });
        return { message_id: msg.id, channel_id: channel.id, question: p.question };
      }
      default: throw unknownAction("send_message", args.action, ["send", "reply", "edit", "poll"]);
    }
  },

  async manage_message(args) {
    const guild = resolveGuild(args);
    const channel = await resolveChannel(guild, args.channel, { textOnly: true });
    const fetchMsg = async () => {
      requireArgs(args, ["message_id"]);
      return await channel.messages.fetch(args.message_id);
    };
    switch (args.action) {
      case "pin": { const m = await fetchMsg(); await m.pin(); return { pinned: m.id, channel_id: channel.id }; }
      case "unpin": { const m = await fetchMsg(); await m.unpin(); return { unpinned: m.id, channel_id: channel.id }; }
      case "delete": { const m = await fetchMsg(); await m.delete(); return { deleted: m.id, channel_id: channel.id }; }
      case "bulk_delete": {
        requireArgs(args, ["message_ids"]);
        if (args.message_ids.length > 100) throw new Error("bulk_delete supports at most 100 messages per call.");
        const deleted = await channel.bulkDelete(args.message_ids, true);
        return { channel_id: channel.id, deleted_count: deleted.size, requested: args.message_ids.length };
      }
      case "react": {
        requireArgs(args, ["emoji"]);
        const m = await fetchMsg();
        await m.react(args.emoji);
        return { message_id: m.id, emoji: args.emoji, reacted: true };
      }
      case "unreact": {
        requireArgs(args, ["emoji"]);
        const m = await fetchMsg();
        const reaction = m.reactions.cache.find((r) => r.emoji.toString() === args.emoji || r.emoji.name === args.emoji);
        if (!reaction) throw new Error(`No reaction "${args.emoji}" found on message ${m.id}.`);
        await reaction.users.remove(discord.user.id);
        return { message_id: m.id, emoji: args.emoji, removed: true };
      }
      default: throw unknownAction("manage_message", args.action, ["pin", "unpin", "delete", "bulk_delete", "react", "unreact"]);
    }
  },

  async dm(args) {
    let user;
    if (ID_RE.test(args.user || "")) {
      user = await discord.users.fetch(args.user);
    } else {
      const guild = resolveGuild(args);
      user = (await resolveMember(guild, args.user)).user;
    }
    const dmChannel = await user.createDM();
    switch (args.action) {
      case "send": {
        const msg = await dmChannel.send(buildMessagePayload(args));
        return { message_id: msg.id, user_id: user.id, username: user.username };
      }
      case "reply": {
        requireArgs(args, ["message_id"]);
        const target = await dmChannel.messages.fetch(args.message_id);
        const msg = await target.reply({ ...buildMessagePayload(args), allowedMentions: { repliedUser: true } });
        return { message_id: msg.id, user_id: user.id, replied_to: args.message_id };
      }
      case "edit": {
        requireArgs(args, ["message_id"]);
        const msg = await dmChannel.messages.fetch(args.message_id);
        await msg.edit(buildMessagePayload(args));
        return { edited: args.message_id, user_id: user.id };
      }
      case "delete": {
        requireArgs(args, ["message_id"]);
        const msg = await dmChannel.messages.fetch(args.message_id);
        await msg.delete();
        return { deleted: args.message_id, user_id: user.id };
      }
      case "history": {
        const opts = { limit: Math.min(args.limit || 20, 100) };
        if (args.before) opts.before = args.before;
        const messages = await dmChannel.messages.fetch(opts);
        return {
          user_id: user.id, username: user.username,
          messages: [...messages.values()].reverse().map((m) => mapMessage(m)),
        };
      }
      default: throw unknownAction("dm", args.action, ["send", "reply", "edit", "delete", "history"]);
    }
  },

  async thread(args) {
    const guild = resolveGuild(args);
    switch (args.action) {
      case "create": {
        requireArgs(args, ["channel", "name"]);
        const parent = await resolveChannel(guild, args.channel);
        const autoArchiveDuration = args.auto_archive_minutes || 1440;
        if (parent.type === ChannelType.GuildForum) {
          if (!args.content && !args.embed) throw new Error("Forum posts require 'content' (or an embed) for the initial message.");
          let appliedTags;
          if (args.tags?.length) {
            appliedTags = args.tags.map((name) => {
              const tag = parent.availableTags.find((t) => t.name.toLowerCase() === name.toLowerCase());
              if (!tag) throw new Error(`Forum tag "${name}" not found. Available: ${parent.availableTags.map((t) => t.name).join(", ") || "none"}.`);
              return tag.id;
            });
          }
          const post = await parent.threads.create({
            name: args.name, autoArchiveDuration,
            message: buildMessagePayload(args),
            ...(appliedTags && { appliedTags }),
          });
          return { thread_id: post.id, name: post.name, parent_id: parent.id, type: "forum_post", url: `https://discord.com/channels/${guild.id}/${post.id}` };
        }
        if (!parent.isTextBased()) throw new Error(`Cannot create a thread in "${parent.name}" (${channelTypeName(parent.type)}).`);
        let thread;
        if (args.message_id) {
          const msg = await parent.messages.fetch(args.message_id);
          thread = await msg.startThread({ name: args.name, autoArchiveDuration });
        } else {
          thread = await parent.threads.create({ name: args.name, autoArchiveDuration });
        }
        if (args.content || args.embed) await thread.send(buildMessagePayload(args));
        return { thread_id: thread.id, name: thread.name, parent_id: parent.id };
      }
      case "list": {
        const active = await guild.channels.fetchActiveThreads();
        let threads = [...active.threads.values()];
        if (args.channel) {
          const parent = await resolveChannel(guild, args.channel);
          threads = threads.filter((t) => t.parentId === parent.id);
        }
        return {
          count: threads.length,
          threads: threads.map((t) => ({
            id: t.id, name: t.name, parent_id: t.parentId,
            archived: t.archived, locked: t.locked,
            message_count: t.messageCount, member_count: t.memberCount,
          })),
        };
      }
      case "edit": {
        requireArgs(args, ["channel"]);
        const thread = await resolveChannel(guild, args.channel);
        if (!thread.isThread()) throw new Error(`"${thread.name}" is not a thread.`);
        const edits = {};
        if (args.name !== undefined) edits.name = args.name;
        if (args.archived !== undefined) edits.archived = args.archived;
        if (args.locked !== undefined) edits.locked = args.locked;
        if (args.auto_archive_minutes !== undefined) edits.autoArchiveDuration = args.auto_archive_minutes;
        if (!Object.keys(edits).length) throw new Error("No properties to edit were provided.");
        await thread.edit(edits);
        return { thread_id: thread.id, name: thread.name, edited: Object.keys(edits) };
      }
      default: throw unknownAction("thread", args.action, ["create", "list", "edit"]);
    }
  },

  async role(args) {
    const guild = resolveGuild(args);
    switch (args.action) {
      case "list": {
        await guild.roles.fetch();
        return {
          roles: [...guild.roles.cache.values()]
            .filter((r) => r.name !== "@everyone")
            .sort((a, b) => b.position - a.position)
            .map((r) => ({
              id: r.id, name: r.name, color: r.hexColor, position: r.position,
              member_count: r.members.size, hoist: r.hoist, mentionable: r.mentionable,
            })),
        };
      }
      case "create": {
        requireArgs(args, ["name"]);
        const opts = {
          name: args.name, color: args.color || null,
          hoist: args.hoist || false, mentionable: args.mentionable || false,
          reason: args.reason,
        };
        if (args.permissions) opts.permissions = permissionFlags(args.permissions);
        const role = await guild.roles.create(opts);
        return { id: role.id, name: role.name, color: role.hexColor };
      }
      case "edit": {
        const role = resolveRole(guild, args.role);
        const edits = {};
        if (args.name !== undefined) edits.name = args.name;
        if (args.color !== undefined) edits.color = args.color;
        if (args.hoist !== undefined) edits.hoist = args.hoist;
        if (args.mentionable !== undefined) edits.mentionable = args.mentionable;
        if (args.permissions) edits.permissions = permissionFlags(args.permissions);
        if (!Object.keys(edits).length) throw new Error("No properties to edit were provided.");
        await role.edit({ ...edits, reason: args.reason });
        return { id: role.id, name: role.name, edited: Object.keys(edits) };
      }
      case "delete": {
        const role = resolveRole(guild, args.role);
        const name = role.name;
        await role.delete(args.reason);
        return { deleted: role.id, name };
      }
      case "assign": {
        const member = await resolveMember(guild, args.user);
        const role = resolveRole(guild, args.role);
        await member.roles.add(role, args.reason);
        return { user: member.user.username, user_id: member.id, role: role.name, assigned: true };
      }
      case "remove": {
        const member = await resolveMember(guild, args.user);
        const role = resolveRole(guild, args.role);
        await member.roles.remove(role, args.reason);
        return { user: member.user.username, user_id: member.id, role: role.name, removed: true };
      }
      default: throw unknownAction("role", args.action, ["list", "create", "edit", "delete", "assign", "remove"]);
    }
  },

  async member(args) {
    const guild = resolveGuild(args);
    switch (args.action) {
      case "list": {
        const limit = Math.min(args.limit || 100, 1000);
        await guild.members.fetch();
        let members = [...guild.members.cache.values()];
        if (args.role) {
          const role = resolveRole(guild, args.role);
          members = members.filter((m) => m.roles.cache.has(role.id));
        }
        return {
          total: members.length,
          members: members.slice(0, limit).map((m) => ({
            id: m.id, username: m.user.username, display_name: m.displayName,
            ...(m.user.bot && { is_bot: true }),
            joined_at: m.joinedAt,
          })),
        };
      }
      case "get": {
        const m = await resolveMember(guild, args.user);
        return {
          id: m.id, username: m.user.username, display_name: m.displayName,
          nickname: m.nickname, is_bot: m.user.bot,
          avatar_url: m.displayAvatarURL({ size: 512 }),
          joined_at: m.joinedAt, account_created_at: m.user.createdAt,
          boosting_since: m.premiumSince,
          timed_out_until: m.communicationDisabledUntil,
          roles: m.roles.cache.filter((r) => r.name !== "@everyone").map((r) => ({ id: r.id, name: r.name })),
        };
      }
      case "edit": {
        const m = await resolveMember(guild, args.user);
        const changes = [];
        if (args.nickname !== undefined) {
          await m.setNickname(args.nickname || null, args.reason);
          changes.push(`nickname: ${args.nickname || "cleared"}`);
        }
        if (args.add_roles?.length) {
          const roles = args.add_roles.map((r) => resolveRole(guild, r));
          await m.roles.add(roles, args.reason);
          changes.push(`added roles: ${roles.map((r) => r.name).join(", ")}`);
        }
        if (args.remove_roles?.length) {
          const roles = args.remove_roles.map((r) => resolveRole(guild, r));
          await m.roles.remove(roles, args.reason);
          changes.push(`removed roles: ${roles.map((r) => r.name).join(", ")}`);
        }
        if (!changes.length) throw new Error("Provide 'nickname', 'add_roles' and/or 'remove_roles'.");
        return { user_id: m.id, username: m.user.username, changes };
      }
      case "prune": {
        const days = args.days || 7;
        const dry = args.dry_run !== false;
        const count = await guild.members.prune({ days, dry, count: true, reason: args.reason });
        return { dry_run: dry, days, [dry ? "would_prune" : "pruned"]: count };
      }
      default: throw unknownAction("member", args.action, ["list", "get", "edit", "prune"]);
    }
  },

  async moderate(args) {
    const guild = resolveGuild(args);
    const reason = args.reason || "No reason provided";
    switch (args.action) {
      case "kick": {
        const m = await resolveMember(guild, args.user);
        await m.kick(reason);
        return { kicked: m.id, username: m.user.username, reason };
      }
      case "ban": {
        const m = await resolveMember(guild, args.user);
        await guild.members.ban(m.id, { reason, deleteMessageSeconds: (args.delete_message_days || 0) * 86400 });
        return { banned: m.id, username: m.user.username, reason };
      }
      case "unban": {
        requireArgs(args, ["user"]);
        if (!ID_RE.test(args.user)) throw new Error("unban requires the user's ID (banned users aren't members, so names can't be resolved). Use action=list_bans to find it.");
        await guild.members.unban(args.user, reason);
        return { unbanned: args.user, reason };
      }
      case "timeout": {
        requireArgs(args, ["duration_minutes"]);
        const m = await resolveMember(guild, args.user);
        const ms = args.duration_minutes * 60 * 1000;
        await m.timeout(ms, reason);
        return { timed_out: m.id, username: m.user.username, duration_minutes: args.duration_minutes, until: new Date(Date.now() + ms), reason };
      }
      case "remove_timeout": {
        const m = await resolveMember(guild, args.user);
        await m.timeout(null);
        return { user_id: m.id, username: m.user.username, timeout_removed: true };
      }
      case "list_bans": {
        const bans = await guild.bans.fetch({ limit: Math.min(args.limit || 100, 1000) });
        return { total: bans.size, bans: [...bans.values()].map((b) => ({ user_id: b.user.id, username: b.user.username, reason: b.reason })) };
      }
      case "audit_log": {
        const opts = { limit: Math.min(args.limit || 20, 100) };
        if (args.audit_action) opts.type = AUDIT_LOG_ACTIONS[args.audit_action];
        if (args.user && ID_RE.test(args.user)) opts.user = args.user;
        const logs = await guild.fetchAuditLogs(opts);
        return {
          entries: [...logs.entries.values()].map((e) => ({
            action: Object.keys(AuditLogEvent).find((k) => AuditLogEvent[k] === e.action) || e.action,
            executor: e.executor?.username, target_id: e.targetId,
            reason: e.reason, created_at: e.createdAt,
          })),
        };
      }
      default: throw unknownAction("moderate", args.action, ["kick", "ban", "unban", "timeout", "remove_timeout", "list_bans", "audit_log"]);
    }
  },

  async invite(args) {
    const guild = resolveGuild(args);
    switch (args.action) {
      case "create": {
        requireArgs(args, ["channel"]);
        const ch = await resolveChannel(guild, args.channel);
        const invite = await ch.createInvite({
          maxAge: args.max_age_seconds ?? 86400,
          maxUses: args.max_uses ?? 0,
          temporary: args.temporary ?? false,
          unique: args.unique ?? false,
        });
        return { code: invite.code, url: invite.url, channel_id: ch.id, max_age: invite.maxAge, max_uses: invite.maxUses };
      }
      case "list": {
        const invites = await guild.invites.fetch();
        return {
          total: invites.size,
          invites: [...invites.values()].map((i) => ({
            code: i.code, url: i.url, channel: i.channel?.name,
            inviter: i.inviter?.username, uses: i.uses, max_uses: i.maxUses,
            max_age: i.maxAge, created_at: i.createdAt,
          })),
        };
      }
      case "delete": {
        requireArgs(args, ["code"]);
        const invite = await discord.fetchInvite(args.code);
        await invite.delete();
        return { deleted: args.code };
      }
      default: throw unknownAction("invite", args.action, ["create", "list", "delete"]);
    }
  },

  async webhook(args) {
    switch (args.action) {
      case "create": {
        requireArgs(args, ["channel", "name"]);
        const guild = resolveGuild(args);
        const ch = await resolveChannel(guild, args.channel, { textOnly: true });
        const opts = { name: args.name };
        if (args.avatar_url) opts.avatar = args.avatar_url;
        const webhook = await ch.createWebhook(opts);
        return { id: webhook.id, name: webhook.name, url: webhook.url, channel_id: ch.id };
      }
      case "list": {
        const guild = resolveGuild(args);
        let webhooks;
        if (args.channel) {
          const ch = await resolveChannel(guild, args.channel, { textOnly: true });
          webhooks = await ch.fetchWebhooks();
        } else {
          webhooks = await guild.fetchWebhooks();
        }
        return {
          total: webhooks.size,
          webhooks: [...webhooks.values()].map((w) => ({
            id: w.id, name: w.name, url: w.url, channel_id: w.channelId,
            channel_name: guild.channels.cache.get(w.channelId)?.name,
            creator: w.owner?.username,
          })),
        };
      }
      case "delete": {
        requireArgs(args, ["webhook_id"]);
        const webhook = await discord.fetchWebhook(args.webhook_id);
        await webhook.delete();
        return { deleted: args.webhook_id, name: webhook.name };
      }
      case "send": {
        requireArgs(args, ["webhook_url"]);
        const payload = buildMessagePayload(args);
        const body = {
          ...(payload.content && { content: payload.content }),
          ...(payload.embeds && { embeds: payload.embeds }),
          ...(args.username && { username: args.username }),
          ...(args.avatar_url && { avatar_url: args.avatar_url }),
        };
        const res = await fetch(args.webhook_url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`Webhook send failed: ${res.status} ${await res.text()}`);
        return { sent: true };
      }
      default: throw unknownAction("webhook", args.action, ["create", "list", "delete", "send"]);
    }
  },

  async automod(args) {
    const guild = resolveGuild(args);
    const TRIGGERS = {
      keyword: AutoModerationRuleTriggerType.Keyword,
      spam: AutoModerationRuleTriggerType.Spam,
      keyword_preset: AutoModerationRuleTriggerType.KeywordPreset,
      mention_spam: AutoModerationRuleTriggerType.MentionSpam,
    };
    const PRESETS = {
      profanity: AutoModerationRuleKeywordPresetType.Profanity,
      sexual_content: AutoModerationRuleKeywordPresetType.SexualContent,
      slurs: AutoModerationRuleKeywordPresetType.Slurs,
    };
    const buildActions = async () => {
      const actions = [];
      if (args.block_message !== false) actions.push({ type: AutoModerationActionType.BlockMessage });
      if (args.alert_channel) {
        const ch = await resolveChannel(guild, args.alert_channel, { textOnly: true });
        actions.push({ type: AutoModerationActionType.SendAlertMessage, metadata: { channel: ch.id } });
      }
      if (args.timeout_seconds) {
        actions.push({ type: AutoModerationActionType.Timeout, metadata: { durationSeconds: args.timeout_seconds } });
      }
      return actions;
    };
    switch (args.action) {
      case "list": {
        const rules = await guild.autoModerationRules.fetch();
        return {
          total: rules.size,
          rules: [...rules.values()].map((r) => ({
            id: r.id, name: r.name, enabled: r.enabled,
            trigger: Object.keys(TRIGGERS).find((k) => TRIGGERS[k] === r.triggerType) || r.triggerType,
            keywords: r.triggerMetadata.keywordFilter?.length ? r.triggerMetadata.keywordFilter : undefined,
            regex_patterns: r.triggerMetadata.regexPatterns?.length ? r.triggerMetadata.regexPatterns : undefined,
            mention_limit: r.triggerMetadata.mentionTotalLimit || undefined,
            actions: r.actions.map((a) => ({
              type: Object.keys(AutoModerationActionType).find((k) => AutoModerationActionType[k] === a.type),
              channel_id: a.metadata?.channelId || undefined,
              duration_seconds: a.metadata?.durationSeconds || undefined,
            })),
          })),
        };
      }
      case "create": {
        requireArgs(args, ["name", "trigger"]);
        const triggerType = TRIGGERS[args.trigger];
        if (triggerType === undefined) throw new Error(`Unknown trigger "${args.trigger}". Use: ${Object.keys(TRIGGERS).join(", ")}.`);
        const triggerMetadata = {};
        if (args.keywords) triggerMetadata.keywordFilter = args.keywords;
        if (args.regex_patterns) triggerMetadata.regexPatterns = args.regex_patterns;
        if (args.allow_list) triggerMetadata.allowList = args.allow_list;
        if (args.presets) triggerMetadata.presets = args.presets.map((p) => PRESETS[p]).filter((p) => p !== undefined);
        if (args.mention_limit) triggerMetadata.mentionTotalLimit = args.mention_limit;
        const actions = await buildActions();
        if (!actions.length) throw new Error("At least one response is required: block_message, alert_channel, or timeout_seconds.");
        const rule = await guild.autoModerationRules.create({
          name: args.name,
          eventType: AutoModerationRuleEventType.MessageSend,
          triggerType, triggerMetadata, actions,
          enabled: args.enabled !== false,
          ...(args.exempt_roles && { exemptRoles: args.exempt_roles.map((r) => resolveRole(guild, r).id) }),
          ...(args.exempt_channels && { exemptChannels: await Promise.all(args.exempt_channels.map(async (c) => (await resolveChannel(guild, c)).id)) }),
        });
        return { id: rule.id, name: rule.name, enabled: rule.enabled };
      }
      case "edit": {
        requireArgs(args, ["rule_id"]);
        const rule = await guild.autoModerationRules.fetch(args.rule_id);
        const edits = {};
        if (args.name !== undefined) edits.name = args.name;
        if (args.enabled !== undefined) edits.enabled = args.enabled;
        const triggerMetadata = { ...rule.triggerMetadata };
        let metaChanged = false;
        if (args.keywords) { triggerMetadata.keywordFilter = args.keywords; metaChanged = true; }
        if (args.regex_patterns) { triggerMetadata.regexPatterns = args.regex_patterns; metaChanged = true; }
        if (args.allow_list) { triggerMetadata.allowList = args.allow_list; metaChanged = true; }
        if (args.mention_limit) { triggerMetadata.mentionTotalLimit = args.mention_limit; metaChanged = true; }
        if (metaChanged) edits.triggerMetadata = triggerMetadata;
        if (args.block_message !== undefined || args.alert_channel || args.timeout_seconds) {
          edits.actions = await buildActions();
        }
        if (!Object.keys(edits).length) throw new Error("No properties to edit were provided.");
        await rule.edit(edits);
        return { id: rule.id, name: rule.name, edited: Object.keys(edits) };
      }
      case "delete": {
        requireArgs(args, ["rule_id"]);
        const rule = await guild.autoModerationRules.fetch(args.rule_id);
        const name = rule.name;
        await rule.delete();
        return { deleted: args.rule_id, name };
      }
      default: throw unknownAction("automod", args.action, ["list", "create", "edit", "delete"]);
    }
  },

  async bot(args) {
    switch (args.action) {
      case "info": {
        const u = discord.user;
        return {
          id: u.id, username: u.username, avatar_url: u.displayAvatarURL(),
          guilds: discord.guilds.cache.size,
          uptime_seconds: Math.floor(discord.uptime / 1000),
          ws_ping_ms: discord.ws.ping,
        };
      }
      case "set_status": {
        const presence = {};
        if (args.status) presence.status = args.status;
        if (args.activity_name || args.activity_type) {
          presence.activities = [{
            name: args.activity_name || "discord-mcp",
            type: ACTIVITY_TYPES[args.activity_type] ?? ActivityType.Playing,
            ...(args.activity_url && { url: args.activity_url }),
          }];
        }
        if (!Object.keys(presence).length) throw new Error("Provide 'status' and/or an activity.");
        discord.user.setPresence(presence);
        return { status: args.status || "unchanged", activity: args.activity_name || null };
      }
      default: throw unknownAction("bot", args.action, ["info", "set_status"]);
    }
  },
};

// Batch mode: every tool accepts an optional `requests` array. Each item is a
// full set of per-item params merged over the top-level args (top-level values
// like guild_id or action act as shared defaults). Executes in parallel.
for (const tool of tools) {
  tool.inputSchema.properties.requests = {
    type: "array",
    items: { type: "object" },
    description: "Batch mode: array of param objects (same fields as this tool). Runs all in parallel; top-level params are shared defaults.",
  };
}

// ---------- server wiring ----------

const server = new Server(
  { name: "discord-mcp", version: "6.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

const ERROR_HINTS = {
  50013: "The bot is missing permissions for this action. Check its role permissions and role position in Server Settings.",
  50001: "The bot cannot access this channel or resource. Check channel permission overwrites.",
  10003: "Unknown channel — it may have been deleted. Run channel with action=list.",
  10008: "Unknown message — it may have been deleted or is in a different channel.",
  10011: "Unknown role. Run role with action=list.",
  10013: "Unknown user.",
  50007: "Cannot send DMs to this user (they may have DMs disabled or blocked the bot).",
  50035: "Discord rejected the request payload — a field is invalid or too long.",
  160002: "Cannot reply: the referenced message no longer exists.",
};

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  try {
    const handler = handlers[name];
    if (!handler) throw new Error(`Unknown tool: ${name}`);
    const validActions = tools.find((t) => t.name === name).inputSchema.properties.action.enum;
    const checkAction = (a) => { if (!validActions.includes(a.action)) throw unknownAction(name, a.action, validActions); };
    await discordReady;
    let result;
    if (Array.isArray(args.requests) && args.requests.length) {
      const settled = await Promise.allSettled(args.requests.map(async (req) => {
        const merged = { ...args, ...req };
        delete merged.requests;
        checkAction(merged);
        return handler(merged);
      }));
      result = settled.map((r, i) =>
        r.status === "fulfilled"
          ? { ...r.value, status: "success" }
          : { ...args.requests[i], status: "failed", error: r.reason?.message }
      );
    } else {
      checkAction(args);
      result = await handler(args);
    }
    let text = JSON.stringify(result, null, 2);
    if (text.length > MAX_RESPONSE_CHARS) {
      text = text.slice(0, MAX_RESPONSE_CHARS) + `\n... [truncated at ${MAX_RESPONSE_CHARS} chars — use 'limit' or pagination parameters to narrow the request]`;
    }
    return { content: [{ type: "text", text }] };
  } catch (error) {
    let message = error.message;
    if (error.code && ERROR_HINTS[error.code]) message += ` — ${ERROR_HINTS[error.code]}`;
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write("discord-mcp v6.0.0 running (14 tools)\n");
