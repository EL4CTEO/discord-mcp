#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Client, GatewayIntentBits, ChannelType, PermissionsBitField, AuditLogEvent } from "discord.js";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, ".discord-mcp-config.json");

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
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.DirectMessageReactions,
    GatewayIntentBits.GuildInvites,
    GatewayIntentBits.GuildWebhooks,
    GatewayIntentBits.GuildScheduledEvents,
    GatewayIntentBits.GuildEmojisAndStickers,
    GatewayIntentBits.GuildIntegrations,
  ],
});

const discordReady = new Promise((resolve, reject) => {
  discord.once("ready", resolve);
  discord.once("error", reject);
  discord.login(BOT_TOKEN).catch(reject);
});

const server = new Server(
  { name: "discord-mcp", version: "3.1.0" },
  { capabilities: { tools: {} } }
);

async function requireDiscord() {
  await discordReady;
}

function resolveGuildId(args) {
  if (args.guild_id) return args.guild_id;
  const config = loadConfig();
  if (config.default_guild_id) return config.default_guild_id;
  throw new Error("No guild_id provided and no default guild set. Use set_guild first.");
}

function getGuild(guildId) {
  const guild = discord.guilds.cache.get(guildId);
  if (!guild) throw new Error(`Guild ${guildId} not found or bot is not in this server`);
  return guild;
}

async function resolveMember(guild, userIdOrName) {
  if (/^\d{17,20}$/.test(userIdOrName)) {
    return await guild.members.fetch(userIdOrName);
  }
  await guild.members.fetch();
  const lower = userIdOrName.toLowerCase();
  const member = guild.members.cache.find(
    (m) =>
      m.user.username.toLowerCase() === lower ||
      m.displayName.toLowerCase() === lower ||
      (m.user.globalName && m.user.globalName.toLowerCase() === lower)
  );
  if (!member) throw new Error(`User "${userIdOrName}" not found in this server`);
  return member;
}

function resolveRole(guild, roleIdOrName) {
  if (/^\d{17,20}$/.test(roleIdOrName)) {
    const role = guild.roles.cache.get(roleIdOrName);
    if (!role) throw new Error(`Role ${roleIdOrName} not found`);
    return role;
  }
  const lower = roleIdOrName.toLowerCase();
  const role = guild.roles.cache.find((r) => r.name.toLowerCase() === lower);
  if (!role) throw new Error(`Role "${roleIdOrName}" not found`);
  return role;
}

async function resolveTextChannel(guild, channelIdOrName) {
  let channel = guild.channels.cache.get(channelIdOrName);
  if (!channel) {
    try { channel = await discord.channels.fetch(channelIdOrName); } catch {}
  }
  if (!channel) {
    const lower = channelIdOrName.toLowerCase();
    channel = guild.channels.cache.find(
      (c) => c.name && c.name.toLowerCase() === lower && c.isTextBased()
    );
  }
  if (!channel) {
    const activeThreads = await guild.channels.fetchActiveThreads();
    channel = activeThreads.threads.get(channelIdOrName);
    if (!channel) {
      const lower = channelIdOrName.toLowerCase();
      channel = activeThreads.threads.find((t) => t.name.toLowerCase() === lower);
    }
  }
  if (!channel) throw new Error(`Channel/thread "${channelIdOrName}" not found`);
  if (!channel.isTextBased()) throw new Error(`Channel "${channelIdOrName}" is not text-based`);
  return channel;
}

function resolveAnyChannel(guild, channelIdOrName) {
  let channel = guild.channels.cache.get(channelIdOrName);
  if (!channel) {
    const lower = channelIdOrName.toLowerCase();
    channel = guild.channels.cache.find((c) => c.name && c.name.toLowerCase() === lower);
  }
  if (!channel) throw new Error(`Channel "${channelIdOrName}" not found`);
  return channel;
}

async function fetchThread(guild, threadId) {
  const cached = guild.channels.cache.get(threadId);
  if (cached && cached.isThread()) return cached;
  try {
    const fetched = await discord.channels.fetch(threadId);
    if (fetched && fetched.isThread()) return fetched;
  } catch {}
  const activeThreads = await guild.channels.fetchActiveThreads();
  const active = activeThreads.threads.get(threadId);
  if (active) return active;
  throw new Error(`Thread ${threadId} not found or bot cannot access it`);
}

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
  if (!payload.content && !payload.embeds) throw new Error("Either content or embed is required");
  return payload;
}

function mapAttachments(m) {
  return [...m.attachments.values()].map(a => ({ name: a.name, url: a.url, size: a.size }));
}

function mapEmbeds(m) {
  return m.embeds.map(e => ({ title: e.title, description: e.description?.slice(0, 300), url: e.url, image: e.image?.url, thumbnail: e.thumbnail?.url }));
}

function mapEmbedsShort(m) {
  return m.embeds.map(e => ({ title: e.title, url: e.url, image: e.image?.url }));
}

const tools = [
  { name: "set_guild", description: "Persist a default guild (server) ID to disk. Call this ONCE \u2014 it survives restarts. After setting, all other tools work without specifying guild_id.", inputSchema: { type: "object", properties: { guild_id: { type: "string" } }, required: ["guild_id"] } },
  { name: "get_guild", description: "Get the persisted default guild ID. Call only when unsure if a default has already been set.", inputSchema: { type: "object", properties: {} } },
  { name: "list_guilds", description: "List all Discord servers the bot is in. Use only when the guild ID is unknown.", inputSchema: { type: "object", properties: {} } },
  { name: "guild_info", description: "Get detailed guild information: icon, banner, features, verification level, vanity URL, system channel, AFK settings, etc.", inputSchema: { type: "object", properties: { guild_id: { type: "string" } } } },
  { name: "list_channels", description: "List all channels and categories in the guild with their IDs, names, and types. Use this to resolve a channel name to an ID before sending messages or reading messages. Do NOT use server_analysis or channel_analysis just to find a channel ID.", inputSchema: { type: "object", properties: { guild_id: { type: "string" } } } },
  { name: "create_channel", description: "Create a single text channel in a guild", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, name: { type: "string" }, category_id: { type: "string" }, topic: { type: "string" }, nsfw: { type: "boolean" }, slowmode: { type: "number", description: "Slowmode in seconds (0-21600)" } }, required: ["name"] } },
  { name: "create_category", description: "Create a single category in a guild", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, name: { type: "string" } }, required: ["name"] } },
  { name: "create_voice_channel", description: "Create a single voice channel in a guild", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, name: { type: "string" }, category_id: { type: "string" }, user_limit: { type: "number" }, bitrate: { type: "number" } }, required: ["name"] } },
  { name: "create_announcement_channel", description: "Create an announcement (news) channel in a guild", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, name: { type: "string" }, category_id: { type: "string" }, topic: { type: "string" } }, required: ["name"] } },
  { name: "edit_channel", description: "Edit any channel property: name, topic, NSFW, slowmode, bitrate, user_limit, position, parent category. Accepts channel ID or name.", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, channel_id: { type: "string", description: "Channel ID or name" }, name: { type: "string" }, topic: { type: "string" }, nsfw: { type: "boolean" }, slowmode: { type: "number", description: "Slowmode in seconds (0=off, max 21600)" }, bitrate: { type: "number", description: "Bitrate for voice channels" }, user_limit: { type: "number", description: "User limit for voice channels (0=unlimited)" }, position: { type: "number" }, parent_id: { type: "string", description: "Category ID to move channel into (null to remove)" }, lock_permissions: { type: "boolean", description: "Sync permissions with parent category" } }, required: ["channel_id"] } },
  { name: "rename_channel", description: "Rename an existing channel or category", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, channel_id: { type: "string", description: "Channel ID or name" }, name: { type: "string", description: "New name" } }, required: ["channel_id", "name"] } },
  { name: "set_channel_topic", description: "Set or update the topic of a text channel", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, channel_id: { type: "string", description: "Channel ID or name" }, topic: { type: "string", description: "New topic (empty string to clear)" } }, required: ["channel_id", "topic"] } },
  { name: "move_channel", description: "Move a channel into a different category (or remove it from any category)", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, channel_id: { type: "string", description: "Channel ID to move" }, category_id: { type: "string", description: "Target category ID (omit to remove from category)" } }, required: ["channel_id"] } },
  { name: "clone_channel", description: "Clone a channel with all its settings (permissions, topic, slowmode, etc.)", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, channel_id: { type: "string", description: "Channel ID or name to clone" }, name: { type: "string", description: "New name (optional, defaults to original-clone)" } }, required: ["channel_id"] } },
  { name: "set_channel_permissions", description: "Set permission overwrites for a role or user on a channel. Use Discord permission names like SEND_MESSAGES, VIEW_CHANNEL, etc.", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, channel_id: { type: "string" }, target_id: { type: "string", description: "Role ID or User ID" }, target_type: { type: "string", description: "'role' or 'member'", enum: ["role", "member"] }, allow: { type: "array", items: { type: "string" }, description: "Permission names to allow" }, deny: { type: "array", items: { type: "string" }, description: "Permission names to deny" } }, required: ["channel_id", "target_id", "target_type"] } },
  { name: "mass_channels", description: "Create multiple text channels in parallel.", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, channels: { type: "array", items: { type: "object", properties: { name: { type: "string" }, category_id: { type: "string" }, topic: { type: "string" } }, required: ["name"] } } }, required: ["channels"] } },
  { name: "mass_categories", description: "Create multiple categories in parallel.", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, names: { type: "array", items: { type: "string" } } }, required: ["names"] } },
  { name: "mass_voice_channels", description: "Create multiple voice channels in parallel.", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, channels: { type: "array", items: { type: "object", properties: { name: { type: "string" }, category_id: { type: "string" }, user_limit: { type: "number" } }, required: ["name"] } } }, required: ["channels"] } },
  { name: "delete", description: "Delete a single channel or category by ID", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, channel_id: { type: "string" }, reason: { type: "string" } }, required: ["channel_id"] } },
  { name: "mass_delete", description: "Delete multiple channels/categories in parallel.", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, channel_ids: { type: "array", items: { type: "string" } } }, required: ["channel_ids"] } },
  { name: "get_messages", description: "Fetch recent messages from a channel or thread. Accepts channel_id as ID or name. Supports before_message_id and after_message_id for pagination.", inputSchema: { type: "object", properties: { guild_id: { type: "string", description: "Optional if default guild is set" }, channel_id: { type: "string", description: "Channel or thread ID (or name)" }, limit: { type: "number", description: "Number of messages to fetch (default: 20, max: 100)" }, before_message_id: { type: "string", description: "Fetch messages before this message ID" }, after_message_id: { type: "string", description: "Fetch messages after this message ID" } }, required: ["channel_id"] } },
  { name: "get_message", description: "Fetch a single message by its ID from a channel or thread.", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, channel_id: { type: "string", description: "Channel or thread ID (or name)" }, message_id: { type: "string", description: "The message ID to fetch" } }, required: ["channel_id", "message_id"] } },
  { name: "search_messages", description: "Search for messages containing a keyword in a channel. Fetches up to `limit` recent messages and filters by keyword (case-insensitive).", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, channel_id: { type: "string", description: "Channel ID or name to search in" }, query: { type: "string", description: "Keyword or phrase to search for (case-insensitive)" }, limit: { type: "number", description: "How many recent messages to scan (default: 100, max: 100)" } }, required: ["channel_id", "query"] } },
  { name: "send_message", description: "Send a message (with optional embed) to a channel or thread. Accepts channel_id as ID or name. If channel_id is already known, call directly \u2014 do NOT call list_guilds, set_guild, list_channels, or any other tool first.", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, channel_id: { type: "string", description: "Channel or thread ID (or name)" }, content: { type: "string", description: "Plain text content (optional if embed is provided)" }, embed: { type: "object", description: "Optional Discord embed object", properties: { title: { type: "string" }, description: { type: "string" }, color: { description: "Hex color string (e.g. '#ff0000') or integer" }, url: { type: "string" }, thumbnail: { type: "string", description: "Thumbnail image URL" }, image: { type: "string", description: "Main image URL" }, footer: { description: "Footer text string or { text, icon_url }" }, author: { description: "Author name string or { name, url, icon_url }" }, fields: { type: "array", items: { type: "object", properties: { name: { type: "string" }, value: { type: "string" }, inline: { type: "boolean" } }, required: ["name", "value"] } }, timestamp: { description: "Set to true for current time, or ISO string" } } } }, required: ["channel_id"] } },
  { name: "send_dm", description: "Send a direct message (DM) to a user by their Discord snowflake ID.", inputSchema: { type: "object", properties: { user_id: { type: "string", description: "Discord snowflake ID of the user" }, content: { type: "string", description: "Message content" }, embed: { type: "object", description: "Optional embed (same structure as send_message embed)" } }, required: ["user_id"] } },
  { name: "send_dm_by_username", description: "Send a DM to a user by username or display name (resolves to user ID automatically). The bot must share a server with the user.", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, username: { type: "string", description: "Username or display name of the user" }, content: { type: "string", description: "Message content" }, embed: { type: "object", description: "Optional embed (same structure as send_message embed)" } }, required: ["username"] } },
  { name: "get_dm_history", description: "Fetch recent DM messages between the bot and a user. Use to read DM conversation history.", inputSchema: { type: "object", properties: { user_id: { type: "string", description: "Discord snowflake ID of the user" }, limit: { type: "number", description: "Number of messages to fetch (default: 20, max: 100)" }, before_message_id: { type: "string", description: "Fetch messages before this ID (pagination)" } }, required: ["user_id"] } },
  { name: "reply_message", description: "Reply to a specific message, pinging the original author.", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, channel_id: { type: "string", description: "Channel or thread ID (or name)" }, message_id: { type: "string" }, content: { type: "string" }, embed: { type: "object", description: "Optional embed" }, ping: { type: "boolean", description: "Whether to ping the original author (default: true)" } }, required: ["channel_id", "message_id"] } },
  { name: "edit_message", description: "Edit a message previously sent by the bot", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, channel_id: { type: "string", description: "Channel or thread ID (or name)" }, message_id: { type: "string" }, content: { type: "string" }, embed: { type: "object", description: "Optional embed" } }, required: ["channel_id", "message_id"] } },
  { name: "pin_message", description: "Pin a message in a channel", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, channel_id: { type: "string", description: "Channel ID or name" }, message_id: { type: "string" } }, required: ["channel_id", "message_id"] } },
  { name: "unpin_message", description: "Unpin a message from a channel", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, channel_id: { type: "string", description: "Channel ID or name" }, message_id: { type: "string" } }, required: ["channel_id", "message_id"] } },
  { name: "get_pinned_messages", description: "Get all pinned messages in a channel", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, channel_id: { type: "string", description: "Channel ID or name" } }, required: ["channel_id"] } },
  { name: "mass_send_message", description: "Send messages (with optional embeds) to multiple channels in parallel.", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, messages: { type: "array", items: { type: "object", properties: { channel_id: { type: "string" }, content: { type: "string" }, embed: { type: "object" } }, required: ["channel_id"] } } }, required: ["messages"] } },
  { name: "delete_message", description: "Delete a specific message from a channel", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, channel_id: { type: "string" }, message_id: { type: "string" } }, required: ["channel_id", "message_id"] } },
  { name: "bulk_delete_messages", description: "Delete up to 100 messages at once using Discord's native bulk delete API (much faster than deleting one-by-one). Messages must be less than 14 days old.", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, channel_id: { type: "string", description: "Channel ID or name" }, message_ids: { type: "array", items: { type: "string" }, description: "Array of message IDs to delete (max 100)" } }, required: ["channel_id", "message_ids"] } },
  { name: "mass_delete_message", description: "Delete multiple messages from a channel in parallel. Use bulk_delete_messages instead if messages are less than 14 days old (faster).", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, channel_id: { type: "string" }, message_ids: { type: "array", items: { type: "string" } } }, required: ["channel_id", "message_ids"] } },
  { name: "add_reaction", description: "Add an emoji reaction to a message", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, channel_id: { type: "string", description: "Channel or thread ID (or name)" }, message_id: { type: "string" }, emoji: { type: "string", description: "Unicode emoji (e.g. '\ud83d\udc4d') or custom emoji ID (e.g. '<:name:id>')" } }, required: ["channel_id", "message_id", "emoji"] } },
  { name: "remove_reaction", description: "Remove the bot's reaction from a message", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, channel_id: { type: "string" }, message_id: { type: "string" }, emoji: { type: "string", description: "Unicode emoji or custom emoji string" } }, required: ["channel_id", "message_id", "emoji"] } },
  { name: "get_reactions", description: "Get users who reacted with a specific emoji on a message", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, channel_id: { type: "string" }, message_id: { type: "string" }, emoji: { type: "string" }, limit: { type: "number", description: "Max users to fetch (default: 100)" } }, required: ["channel_id", "message_id", "emoji"] } },
  { name: "crosspost_message", description: "Crosspost (publish) a message in an announcement channel to all following channels", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, channel_id: { type: "string" }, message_id: { type: "string" } }, required: ["channel_id", "message_id"] } },
  { name: "list_roles", description: "List all roles in the guild with their IDs, names, colors, and member counts.", inputSchema: { type: "object", properties: { guild_id: { type: "string" } } } },
  { name: "create_role", description: "Create a single role in a guild", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, name: { type: "string" }, color: { type: "string" }, hoist: { type: "boolean" }, mentionable: { type: "boolean" }, permissions: { type: "array", items: { type: "string" }, description: "Permission names like SEND_MESSAGES, MANAGE_CHANNELS, etc." } }, required: ["name"] } },
  { name: "edit_role", description: "Edit a role's properties: name, color, hoist, mentionable, permissions", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, role_id: { type: "string", description: "Role ID or name" }, name: { type: "string" }, color: { type: "string" }, hoist: { type: "boolean" }, mentionable: { type: "boolean" }, permissions: { type: "array", items: { type: "string" }, description: "Permission names to set" } }, required: ["role_id"] } },
  { name: "delete_role", description: "Delete a single role from a guild", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, role_id: { type: "string" } }, required: ["role_id"] } },
  { name: "mass_create_role", description: "Create multiple roles in parallel.", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, roles: { type: "array", items: { type: "object", properties: { name: { type: "string" }, color: { type: "string" }, hoist: { type: "boolean" }, mentionable: { type: "boolean" } }, required: ["name"] } } }, required: ["roles"] } },
  { name: "mass_delete_role", description: "Delete multiple roles in parallel.", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, role_ids: { type: "array", items: { type: "string" } } }, required: ["role_ids"] } },
  { name: "assign_role", description: "Assign a role to a user. Accepts username or snowflake ID for both user and role.", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, user_id: { type: "string", description: "User snowflake ID or username" }, role_id: { type: "string", description: "Role snowflake ID or role name" } }, required: ["user_id", "role_id"] } },
  { name: "remove_role", description: "Remove a role from a user. Accepts username or snowflake ID for both user and role.", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, user_id: { type: "string", description: "User snowflake ID or username" }, role_id: { type: "string", description: "Role snowflake ID or role name" } }, required: ["user_id", "role_id"] } },
  { name: "list_members", description: "List members in the guild with their IDs, usernames, display names, and roles. Supports optional role filter and limit.", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, role_id: { type: "string", description: "Filter to members that have this role (ID or name)" }, limit: { type: "number", description: "Max members to return (default: 100, max: 1000)" } } } },
  { name: "get_member", description: "Get detailed info about a single member: roles, permissions, join date, boost status, avatar, banner.", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, user_id: { type: "string", description: "User ID or username" } }, required: ["user_id"] } },
  { name: "set_nickname", description: "Set or clear a member's nickname in the guild", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, user_id: { type: "string", description: "User ID or username" }, nickname: { type: "string", description: "New nickname (empty string or null to clear)" } }, required: ["user_id"] } },
  { name: "create_invite", description: "Create an invite link to a channel", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, channel_id: { type: "string", description: "Channel ID or name" }, max_age: { type: "number", description: "Max age in seconds (0 = never expires, default: 86400)" }, max_uses: { type: "number", description: "Max uses (0 = unlimited, default: 0)" }, temporary: { type: "boolean", description: "Temporary membership invite (default: false)" }, unique: { type: "boolean", description: "Force a new unique invite (default: false)" } }, required: ["channel_id"] } },
  { name: "list_invites", description: "List all active invites for the guild", inputSchema: { type: "object", properties: { guild_id: { type: "string" } } } },
  { name: "delete_invite", description: "Delete/revoke an invite by its code", inputSchema: { type: "object", properties: { invite_code: { type: "string" } }, required: ["invite_code"] } },
  { name: "create_webhook", description: "Create a webhook for a channel", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, channel_id: { type: "string", description: "Channel ID or name" }, name: { type: "string", description: "Webhook name" }, avatar: { type: "string", description: "Avatar URL (optional)" } }, required: ["channel_id", "name"] } },
  { name: "list_webhooks", description: "List all webhooks for a channel or the entire guild", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, channel_id: { type: "string", description: "Channel ID or name (omit to list all guild webhooks)" } } } },
  { name: "delete_webhook", description: "Delete a webhook by ID", inputSchema: { type: "object", properties: { webhook_id: { type: "string" } }, required: ["webhook_id"] } },
  { name: "send_webhook_message", description: "Send a message via a webhook URL (allows custom username and avatar per message)", inputSchema: { type: "object", properties: { webhook_url: { type: "string", description: "Full webhook URL" }, content: { type: "string" }, username: { type: "string", description: "Override display name" }, avatar_url: { type: "string", description: "Override avatar URL" }, embed: { type: "object", description: "Optional embed" } }, required: ["webhook_url"] } },
  { name: "list_emojis", description: "List all custom emojis in the guild", inputSchema: { type: "object", properties: { guild_id: { type: "string" } } } },
  { name: "create_emoji", description: "Create a custom emoji from a URL", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, name: { type: "string", description: "Emoji name (alphanumeric and underscores)" }, image_url: { type: "string", description: "URL to the image (PNG, JPG, GIF, max 256KB)" } }, required: ["name", "image_url"] } },
  { name: "delete_emoji", description: "Delete a custom emoji by ID or name", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, emoji_id: { type: "string", description: "Emoji ID or name" } }, required: ["emoji_id"] } },
  { name: "get_audit_log", description: "Fetch recent audit log entries for the guild. Filter by action type or user.", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, action_type: { type: "string", description: "Action type filter: CHANNEL_CREATE, CHANNEL_DELETE, MEMBER_BAN_ADD, MEMBER_KICK, MESSAGE_DELETE, ROLE_CREATE, etc." }, user_id: { type: "string", description: "Filter by user who performed the action" }, limit: { type: "number", description: "Number of entries (default: 20, max: 100)" } } } },
  { name: "server_analysis", description: "Full server overview: members, channels, roles, boosts, features. Do NOT use just to find a channel ID \u2014 use list_channels instead.", inputSchema: { type: "object", properties: { guild_id: { type: "string" } } } },
  { name: "channel_analysis", description: "Analyze message activity in a text channel: top users, top words, message volume, attachments.", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, channel_id: { type: "string" }, limit: { type: "number" } }, required: ["channel_id"] } },
  { name: "user_analysis", description: "Analyze a user's activity: messages per channel, top words, roles, join date, recent messages.", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, user_id: { type: "string" }, limit: { type: "number" } }, required: ["user_id"] } },
  { name: "create_thread", description: "Create a thread inside a text channel. Attach to a message or create standalone.", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, channel_id: { type: "string" }, name: { type: "string" }, message_id: { type: "string" }, auto_archive_duration: { type: "number" }, reason: { type: "string" } }, required: ["channel_id", "name"] } },
  { name: "send_thread_message", description: "Send a message inside a thread. Use thread_id (not channel_id).", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, thread_id: { type: "string" }, content: { type: "string" } }, required: ["thread_id", "content"] } },
  { name: "thread_analysis", description: "Read and analyze all messages in a thread: participants, word frequency, full message history.", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, thread_id: { type: "string" }, limit: { type: "number" } }, required: ["thread_id"] } },
  { name: "list_threads", description: "List active (and optionally archived) threads in a channel or guild", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, channel_id: { type: "string" }, include_archived: { type: "boolean" } } } },
  { name: "archive_thread", description: "Archive or unarchive a thread", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, thread_id: { type: "string" }, archived: { type: "boolean" }, locked: { type: "boolean" } }, required: ["thread_id"] } },
  { name: "create_forum_post", description: "Create a new post (thread) in a Forum channel", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, channel_id: { type: "string", description: "Forum channel ID or name" }, name: { type: "string", description: "Title of the forum post" }, content: { type: "string", description: "Initial message content" }, embed: { type: "object", description: "Optional embed for the initial message" }, auto_archive_duration: { type: "number" } }, required: ["channel_id", "name"] } },
  { name: "kick_user", description: "Kick a user from the guild. Accepts snowflake ID or username.", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, user_id: { type: "string" }, reason: { type: "string" } }, required: ["user_id"] } },
  { name: "ban_user", description: "Ban a user from the guild. Accepts snowflake ID or username.", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, user_id: { type: "string" }, reason: { type: "string" }, delete_message_days: { type: "number" } }, required: ["user_id"] } },
  { name: "unban_user", description: "Unban a user from the guild by snowflake ID", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, user_id: { type: "string" }, reason: { type: "string" } }, required: ["user_id"] } },
  { name: "list_bans", description: "List all banned users in the guild", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, limit: { type: "number", description: "Max bans to fetch (default: 100)" } } } },
  { name: "time_out_user", description: "Timeout a user for a given duration. Accepts snowflake ID or username.", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, user_id: { type: "string" }, duration_minutes: { type: "number" }, reason: { type: "string" } }, required: ["user_id", "duration_minutes"] } },
  { name: "remove_timeout", description: "Remove a timeout from a user", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, user_id: { type: "string" } }, required: ["user_id"] } },
  { name: "mass_ban", description: "Ban multiple users in parallel.", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, user_ids: { type: "array", items: { type: "string" } }, reason: { type: "string" }, delete_message_days: { type: "number" } }, required: ["user_ids"] } },
  { name: "mass_time_out", description: "Timeout multiple users in parallel.", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, user_ids: { type: "array", items: { type: "string" } }, duration_minutes: { type: "number" }, reason: { type: "string" } }, required: ["user_ids", "duration_minutes"] } },
  { name: "bot_info", description: "Get info about the bot itself: username, ID, avatar, guilds count, uptime", inputSchema: { type: "object", properties: {} } },
  { name: "set_bot_status", description: "Set the bot's presence status and activity", inputSchema: { type: "object", properties: { status: { type: "string", enum: ["online", "idle", "dnd", "invisible"], description: "Online status" }, activity_type: { type: "string", enum: ["Playing", "Streaming", "Listening", "Watching", "Competing"], description: "Activity type" }, activity_name: { type: "string", description: "Activity text" }, activity_url: { type: "string", description: "Stream URL (only for Streaming type)" } } } },
  { name: "list_scheduled_events", description: "List all scheduled events in the guild", inputSchema: { type: "object", properties: { guild_id: { type: "string" } } } },
  { name: "create_scheduled_event", description: "Create a guild scheduled event (external location or voice/stage channel)", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, name: { type: "string" }, description: { type: "string" }, start_time: { type: "string", description: "ISO 8601 datetime" }, end_time: { type: "string", description: "ISO 8601 datetime (required for external events)" }, location: { type: "string", description: "External location (use for external events)" }, channel_id: { type: "string", description: "Voice/Stage channel ID (use for voice/stage events)" }, image_url: { type: "string", description: "Cover image URL" } }, required: ["name", "start_time"] } },
  { name: "delete_scheduled_event", description: "Delete a scheduled event by ID", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, event_id: { type: "string" } }, required: ["event_id"] } },
];

const BATCHABLE_TOOLS = new Set([
  "get_messages", "get_message", "search_messages", "get_pinned_messages",
  "send_message", "reply_message", "edit_message", "delete_message",
  "pin_message", "unpin_message", "crosspost_message",
  "add_reaction", "remove_reaction", "get_reactions",
  "send_dm", "get_dm_history",
  "get_member", "set_nickname", "assign_role", "remove_role",
  "kick_user", "ban_user", "unban_user", "time_out_user",
  "rename_channel", "edit_channel", "set_channel_topic", "move_channel",
  "clone_channel", "delete", "create_channel", "create_invite",
  "create_role", "edit_role", "delete_role",
  "create_thread", "archive_thread", "send_thread_message",
  "create_webhook", "delete_webhook", "send_webhook_message",
  "create_emoji", "delete_emoji",
  "delete_scheduled_event",
]);

for (const tool of tools) {
  if (BATCHABLE_TOOLS.has(tool.name)) {
    const itemProps = { ...tool.inputSchema.properties };
    delete itemProps.guild_id;
    tool.inputSchema.properties.requests = {
      type: "array",
      description: "Batch mode: array of per-item params. If provided, executes all in parallel and returns array of results.",
      items: { type: "object", properties: itemProps }
    };
  }
}

const AUDIT_LOG_ACTIONS = {
  CHANNEL_CREATE: AuditLogEvent.ChannelCreate, CHANNEL_UPDATE: AuditLogEvent.ChannelUpdate, CHANNEL_DELETE: AuditLogEvent.ChannelDelete,
  MEMBER_KICK: AuditLogEvent.MemberKick, MEMBER_BAN_ADD: AuditLogEvent.MemberBanAdd, MEMBER_BAN_REMOVE: AuditLogEvent.MemberBanRemove,
  MEMBER_UPDATE: AuditLogEvent.MemberUpdate, MEMBER_ROLE_UPDATE: AuditLogEvent.MemberRoleUpdate,
  ROLE_CREATE: AuditLogEvent.RoleCreate, ROLE_UPDATE: AuditLogEvent.RoleUpdate, ROLE_DELETE: AuditLogEvent.RoleDelete,
  MESSAGE_DELETE: AuditLogEvent.MessageDelete, MESSAGE_BULK_DELETE: AuditLogEvent.MessageBulkDelete,
  INVITE_CREATE: AuditLogEvent.InviteCreate, INVITE_DELETE: AuditLogEvent.InviteDelete,
  WEBHOOK_CREATE: AuditLogEvent.WebhookCreate, WEBHOOK_UPDATE: AuditLogEvent.WebhookUpdate, WEBHOOK_DELETE: AuditLogEvent.WebhookDelete,
  EMOJI_CREATE: AuditLogEvent.EmojiCreate, EMOJI_DELETE: AuditLogEvent.EmojiDelete, BOT_ADD: AuditLogEvent.BotAdd,
};
const ACTIVITY_TYPES = { Playing: 0, Streaming: 1, Listening: 2, Watching: 3, Competing: 5 };

async function handleTool(name, args) {
  await requireDiscord();
  switch (name) {
    case "set_guild": { const guild = getGuild(args.guild_id); const config = loadConfig(); config.default_guild_id = args.guild_id; saveConfig(config); return { success: true, default_guild_id: args.guild_id, guild_name: guild.name }; }
    case "get_guild": { const config = loadConfig(); if (!config.default_guild_id) return { default_guild_id: null, message: "No default guild set. Use set_guild." }; try { const guild = getGuild(config.default_guild_id); return { default_guild_id: config.default_guild_id, guild_name: guild.name, member_count: guild.memberCount }; } catch { return { default_guild_id: config.default_guild_id, message: "Saved but bot may no longer be in this server" }; } }
    case "list_guilds": { const config = loadConfig(); return { guilds: discord.guilds.cache.map((g) => ({ id: g.id, name: g.name, member_count: g.memberCount, is_default: g.id === config.default_guild_id })), default_guild_id: config.default_guild_id || null }; }
    case "send_dm": { const user = await discord.users.fetch(args.user_id); const dmChannel = await user.createDM(); const payload = buildMessagePayload(args); const msg = await dmChannel.send(payload); return { message_id: msg.id, user_id: args.user_id, username: user.username, status: "sent" }; }
    case "get_dm_history": { const user = await discord.users.fetch(args.user_id); const dmChannel = await user.createDM(); const limit = Math.min(args.limit || 20, 100); const fetchOpts = { limit }; if (args.before_message_id) fetchOpts.before = args.before_message_id; const messages = await dmChannel.messages.fetch(fetchOpts); return { user_id: args.user_id, username: user.username, messages: [...messages.values()].reverse().map((m) => ({ id: m.id, author: m.author.username, author_id: m.author.id, is_bot: m.author.bot, content: m.content, timestamp: m.createdAt, edited: !!m.editedAt, attachments: mapAttachments(m), embeds: mapEmbeds(m) })) }; }
    case "bot_info": { const user = discord.user; return { id: user.id, username: user.username, discriminator: user.discriminator, avatar_url: user.displayAvatarURL(), guilds_count: discord.guilds.cache.size, uptime_seconds: Math.floor(discord.uptime / 1000), ready_at: discord.readyAt, ws_ping: discord.ws.ping }; }
    case "set_bot_status": { const presenceData = {}; if (args.status) presenceData.status = args.status; if (args.activity_name || args.activity_type) { presenceData.activities = [{ name: args.activity_name || "discord-mcp", type: ACTIVITY_TYPES[args.activity_type] ?? 0, ...(args.activity_url && { url: args.activity_url }) }]; } discord.user.setPresence(presenceData); return { status: args.status || "online", activity: args.activity_name || null, type: args.activity_type || null }; }
    case "delete_invite": { const invite = await discord.fetchInvite(args.invite_code); await invite.delete(); return { deleted: args.invite_code }; }
    case "delete_webhook": { const webhook = await discord.fetchWebhook(args.webhook_id); await webhook.delete(); return { deleted: args.webhook_id, name: webhook.name }; }
    case "send_webhook_message": { const res = await fetch(args.webhook_url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...(args.content && { content: args.content }), ...(args.username && { username: args.username }), ...(args.avatar_url && { avatar_url: args.avatar_url }), ...(args.embed && { embeds: [args.embed] }) }) }); if (!res.ok) throw new Error(`Webhook send failed: ${res.status} ${await res.text()}`); return { status: "sent" }; }
  }
  const guildId = resolveGuildId(args); const guild = getGuild(guildId);
  switch (name) {
    case "guild_info": { return { id: guild.id, name: guild.name, description: guild.description, icon_url: guild.iconURL({ size: 1024 }), banner_url: guild.bannerURL({ size: 1024 }), splash_url: guild.splashURL({ size: 1024 }), owner_id: guild.ownerId, member_count: guild.memberCount, verification_level: guild.verificationLevel, explicit_content_filter: guild.explicitContentFilter, afk_channel_id: guild.afkChannelId, afk_timeout: guild.afkTimeout, system_channel_id: guild.systemChannelId, rules_channel_id: guild.rulesChannelId, vanity_url_code: guild.vanityURLCode, premium_tier: guild.premiumTier, premium_subscription_count: guild.premiumSubscriptionCount, preferred_locale: guild.preferredLocale, features: guild.features, created_at: guild.createdAt, nsfw_level: guild.nsfwLevel, max_members: guild.maximumMembers }; }
    case "list_channels": { const channels = guild.channels.cache; return { guild_id: guild.id, guild_name: guild.name, channels: channels.sort((a, b) => (a.position || 0) - (b.position || 0)).map((c) => ({ id: c.id, name: c.name, type: c.type === ChannelType.GuildText ? "text" : c.type === ChannelType.GuildVoice ? "voice" : c.type === ChannelType.GuildCategory ? "category" : c.type === ChannelType.GuildForum ? "forum" : c.type === ChannelType.GuildAnnouncement ? "announcement" : c.type === ChannelType.GuildStageVoice ? "stage" : String(c.type), category_id: c.parentId || null, category_name: c.parent?.name || null, topic: c.topic || null, nsfw: c.nsfw || false })) }; }
    case "create_channel": { const opts = { name: args.name, type: ChannelType.GuildText, parent: args.category_id || null, topic: args.topic || null }; if (args.nsfw) opts.nsfw = true; if (args.slowmode) opts.rateLimitPerUser = args.slowmode; const ch = await guild.channels.create(opts); return { id: ch.id, name: ch.name, type: "text" }; }
    case "create_category": { const cat = await guild.channels.create({ name: args.name, type: ChannelType.GuildCategory }); return { id: cat.id, name: cat.name, type: "category" }; }
    case "create_voice_channel": { const opts = { name: args.name, type: ChannelType.GuildVoice, parent: args.category_id || null, userLimit: args.user_limit || 0 }; if (args.bitrate) opts.bitrate = args.bitrate; const vc = await guild.channels.create(opts); return { id: vc.id, name: vc.name, type: "voice" }; }
    case "create_announcement_channel": { const ch = await guild.channels.create({ name: args.name, type: ChannelType.GuildAnnouncement, parent: args.category_id || null, topic: args.topic || null }); return { id: ch.id, name: ch.name, type: "announcement" }; }
    case "edit_channel": { const ch = resolveAnyChannel(guild, args.channel_id); const edits = {}; if (args.name !== undefined) edits.name = args.name; if (args.topic !== undefined) edits.topic = args.topic; if (args.nsfw !== undefined) edits.nsfw = args.nsfw; if (args.slowmode !== undefined) edits.rateLimitPerUser = args.slowmode; if (args.bitrate !== undefined) edits.bitrate = args.bitrate; if (args.user_limit !== undefined) edits.userLimit = args.user_limit; if (args.position !== undefined) edits.position = args.position; if (args.parent_id !== undefined) edits.parent = args.parent_id; if (args.lock_permissions !== undefined) edits.lockPermissions = args.lock_permissions; await ch.edit(edits); return { id: ch.id, name: ch.name, edited: Object.keys(edits) }; }
    case "rename_channel": { const ch = resolveAnyChannel(guild, args.channel_id); const oldName = ch.name; await ch.setName(args.name); return { id: ch.id, old_name: oldName, new_name: args.name }; }
    case "set_channel_topic": { const ch = resolveAnyChannel(guild, args.channel_id); if (!ch.isTextBased() || ch.type === ChannelType.GuildVoice) throw new Error("Cannot set topic on this channel type"); await ch.setTopic(args.topic); return { id: ch.id, name: ch.name, topic: args.topic }; }
    case "move_channel": { const ch = guild.channels.cache.get(args.channel_id); if (!ch) throw new Error(`Channel ${args.channel_id} not found`); await ch.setParent(args.category_id || null); return { id: ch.id, name: ch.name, category_id: args.category_id || null }; }
    case "clone_channel": { const ch = resolveAnyChannel(guild, args.channel_id); const cloned = await ch.clone({ name: args.name || `${ch.name}-clone` }); return { id: cloned.id, name: cloned.name, original_id: ch.id, original_name: ch.name }; }
    case "set_channel_permissions": { const ch = resolveAnyChannel(guild, args.channel_id); const allowBits = args.allow ? args.allow.map((p) => PermissionsBitField.Flags[p]).filter(Boolean) : []; const denyBits = args.deny ? args.deny.map((p) => PermissionsBitField.Flags[p]).filter(Boolean) : []; await ch.permissionOverwrites.edit(args.target_id, { ...Object.fromEntries(allowBits.map((b) => { const n = Object.entries(PermissionsBitField.Flags).find(([, v]) => v === b)?.[0]; return [n, true]; })), ...Object.fromEntries(denyBits.map((b) => { const n = Object.entries(PermissionsBitField.Flags).find(([, v]) => v === b)?.[0]; return [n, false]; })) }); return { channel_id: ch.id, target_id: args.target_id, target_type: args.target_type, allowed: args.allow || [], denied: args.deny || [] }; }
    case "mass_channels": { const results = await Promise.allSettled(args.channels.map((ch) => guild.channels.create({ name: ch.name, type: ChannelType.GuildText, parent: ch.category_id || null, topic: ch.topic || null }))); return results.map((r, i) => r.status === "fulfilled" ? { name: args.channels[i].name, id: r.value.id, status: "created" } : { name: args.channels[i].name, status: "failed", error: r.reason?.message }); }
    case "mass_categories": { const results = await Promise.allSettled(args.names.map((n) => guild.channels.create({ name: n, type: ChannelType.GuildCategory }))); return results.map((r, i) => r.status === "fulfilled" ? { name: args.names[i], id: r.value.id, status: "created" } : { name: args.names[i], status: "failed", error: r.reason?.message }); }
    case "mass_voice_channels": { const results = await Promise.allSettled(args.channels.map((ch) => guild.channels.create({ name: ch.name, type: ChannelType.GuildVoice, parent: ch.category_id || null, userLimit: ch.user_limit || 0 }))); return results.map((r, i) => r.status === "fulfilled" ? { name: args.channels[i].name, id: r.value.id, status: "created" } : { name: args.channels[i].name, status: "failed", error: r.reason?.message }); }
    case "delete": { const ch = guild.channels.cache.get(args.channel_id); if (!ch) throw new Error(`Channel ${args.channel_id} not found`); const chName = ch.name; await ch.delete(args.reason || undefined); return { deleted: args.channel_id, name: chName }; }
    case "mass_delete": { const results = await Promise.allSettled(args.channel_ids.map(async (id) => { const ch = guild.channels.cache.get(id); if (!ch) throw new Error(`Channel ${id} not found`); const n = ch.name; await ch.delete(); return { id, name: n }; })); return results.map((r, i) => r.status === "fulfilled" ? { id: args.channel_ids[i], name: r.value.name, status: "deleted" } : { id: args.channel_ids[i], status: "failed", error: r.reason?.message }); }
    case "get_messages": { const channel = await resolveTextChannel(guild, args.channel_id); const limit = Math.min(args.limit || 20, 100); const fetchOptions = { limit }; if (args.before_message_id) fetchOptions.before = args.before_message_id; if (args.after_message_id) fetchOptions.after = args.after_message_id; const messages = await channel.messages.fetch(fetchOptions); return { channel_id: channel.id, channel_name: channel.name, messages: [...messages.values()].reverse().map((m) => ({ id: m.id, author: m.author.username, author_id: m.author.id, display_name: m.member?.displayName || m.author.username, content: m.content, timestamp: m.createdAt, edited: !!m.editedAt, attachments: mapAttachments(m), embeds: mapEmbeds(m), reactions: m.reactions.cache.map((r) => ({ emoji: r.emoji.toString(), count: r.count })), reply_to: m.reference?.messageId || null, pinned: m.pinned })) }; }
    case "get_message": { const channel = await resolveTextChannel(guild, args.channel_id); const m = await channel.messages.fetch(args.message_id); return { id: m.id, author: m.author.username, author_id: m.author.id, display_name: m.member?.displayName || m.author.username, content: m.content, timestamp: m.createdAt, edited: !!m.editedAt, attachments: [...m.attachments.values()].map((a) => ({ name: a.name, url: a.url, size: a.size })), embeds: m.embeds.map((e) => ({ title: e.title, description: e.description?.slice(0, 200), url: e.url })), reactions: m.reactions.cache.map((r) => ({ emoji: r.emoji.toString(), count: r.count })), reply_to: m.reference?.messageId || null, pinned: m.pinned }; }
    case "search_messages": { const channel = await resolveTextChannel(guild, args.channel_id); const limit = Math.min(args.limit || 100, 100); const messages = await channel.messages.fetch({ limit }); const lower = args.query.toLowerCase(); const matches = [...messages.values()].filter((m) => m.content.toLowerCase().includes(lower)); return { channel_id: channel.id, channel_name: channel.name, query: args.query, total_scanned: messages.size, matches_found: matches.length, messages: matches.reverse().map((m) => ({ id: m.id, author: m.author.username, author_id: m.author.id, content: m.content, timestamp: m.createdAt, attachments: mapAttachments(m), embeds: mapEmbedsShort(m) })) }; }
    case "send_message": { const channel = await resolveTextChannel(guild, args.channel_id); const payload = buildMessagePayload(args); const msg = await channel.send(payload); return { message_id: msg.id, channel_id: channel.id, channel_name: channel.name }; }
    case "send_dm_by_username": { const member = await resolveMember(guild, args.username); const dmChannel = await member.user.createDM(); const payload = buildMessagePayload(args); const msg = await dmChannel.send(payload); return { message_id: msg.id, user_id: member.id, username: member.user.username, status: "sent" }; }
    case "reply_message": { const channel = await resolveTextChannel(guild, args.channel_id); const targetMsg = await channel.messages.fetch(args.message_id); const payload = { ...buildMessagePayload(args), allowedMentions: { repliedUser: args.ping !== false } }; const msg = await targetMsg.reply(payload); return { message_id: msg.id, channel_id: channel.id, replied_to: args.message_id }; }
    case "edit_message": { const channel = await resolveTextChannel(guild, args.channel_id); const msg = await channel.messages.fetch(args.message_id); const payload = buildMessagePayload(args); await msg.edit(payload); return { edited_message_id: args.message_id, channel_id: channel.id }; }
    case "pin_message": { const channel = await resolveTextChannel(guild, args.channel_id); const msg = await channel.messages.fetch(args.message_id); await msg.pin(); return { pinned_message_id: args.message_id, channel_id: channel.id, channel_name: channel.name }; }
    case "unpin_message": { const channel = await resolveTextChannel(guild, args.channel_id); const msg = await channel.messages.fetch(args.message_id); await msg.unpin(); return { unpinned_message_id: args.message_id, channel_id: channel.id, channel_name: channel.name }; }
    case "get_pinned_messages": { const channel = await resolveTextChannel(guild, args.channel_id); const pinned = await channel.messages.fetchPinned(); return { channel_id: channel.id, channel_name: channel.name, count: pinned.size, messages: [...pinned.values()].map((m) => ({ id: m.id, author: m.author.username, content: m.content, timestamp: m.createdAt, attachments: mapAttachments(m), embeds: mapEmbeds(m) })) }; }
    case "mass_send_message": { const results = await Promise.allSettled(args.messages.map(async (m) => { const channel = await resolveTextChannel(guild, m.channel_id); const payload = buildMessagePayload(m); const msg = await channel.send(payload); return { message_id: msg.id, channel_id: channel.id }; })); return results.map((r, i) => r.status === "fulfilled" ? { channel_id: args.messages[i].channel_id, message_id: r.value.message_id, status: "sent" } : { channel_id: args.messages[i].channel_id, status: "failed", error: r.reason?.message }); }
    case "delete_message": { const channel = await resolveTextChannel(guild, args.channel_id); const msg = await channel.messages.fetch(args.message_id); await msg.delete(); return { deleted_message_id: args.message_id, channel_id: channel.id }; }
    case "bulk_delete_messages": { const channel = await resolveTextChannel(guild, args.channel_id); if (args.message_ids.length > 100) throw new Error("bulk_delete_messages supports at most 100 messages at once"); const deleted = await channel.bulkDelete(args.message_ids, true); return { channel_id: channel.id, channel_name: channel.name, deleted_count: deleted.size, requested: args.message_ids.length }; }
    case "mass_delete_message": { const channel = await resolveTextChannel(guild, args.channel_id); const results = await Promise.allSettled(args.message_ids.map(async (id) => { const msg = await channel.messages.fetch(id); await msg.delete(); return id; })); return results.map((r, i) => r.status === "fulfilled" ? { message_id: args.message_ids[i], status: "deleted" } : { message_id: args.message_ids[i], status: "failed", error: r.reason?.message }); }
    case "add_reaction": { const channel = await resolveTextChannel(guild, args.channel_id); const msg = await channel.messages.fetch(args.message_id); await msg.react(args.emoji); return { message_id: args.message_id, emoji: args.emoji, status: "reacted" }; }
    case "remove_reaction": { const channel = await resolveTextChannel(guild, args.channel_id); const msg = await channel.messages.fetch(args.message_id); await msg.reactions.resolve(args.emoji)?.users.remove(discord.user.id); return { message_id: args.message_id, emoji: args.emoji, status: "removed" }; }
    case "get_reactions": { const channel = await resolveTextChannel(guild, args.channel_id); const msg = await channel.messages.fetch(args.message_id); const reaction = msg.reactions.cache.find((r) => r.emoji.toString() === args.emoji || r.emoji.name === args.emoji); if (!reaction) return { emoji: args.emoji, users: [], count: 0 }; const users = await reaction.users.fetch({ limit: args.limit || 100 }); return { emoji: args.emoji, count: reaction.count, users: [...users.values()].map((u) => ({ id: u.id, username: u.username, bot: u.bot })) }; }
    case "crosspost_message": { const channel = await resolveTextChannel(guild, args.channel_id); if (channel.type !== ChannelType.GuildAnnouncement) throw new Error("Channel is not an announcement channel"); const msg = await channel.messages.fetch(args.message_id); await msg.crosspost(); return { crossposted: args.message_id, channel_id: channel.id }; }
    case "list_roles": { await guild.roles.fetch(); return { guild_id: guild.id, guild_name: guild.name, roles: guild.roles.cache.filter((r) => r.name !== "@everyone").sort((a, b) => b.position - a.position).map((r) => ({ id: r.id, name: r.name, color: r.hexColor, hoist: r.hoist, mentionable: r.mentionable, position: r.position, member_count: r.members.size, permissions: r.permissions.toArray() })) }; }
    case "create_role": { const opts = { name: args.name, color: args.color || null, hoist: args.hoist || false, mentionable: args.mentionable || false }; if (args.permissions) opts.permissions = args.permissions.map((p) => PermissionsBitField.Flags[p]).filter(Boolean); const role = await guild.roles.create(opts); return { id: role.id, name: role.name, color: role.hexColor, hoist: role.hoist, mentionable: role.mentionable }; }
    case "edit_role": { const role = resolveRole(guild, args.role_id); const edits = {}; if (args.name !== undefined) edits.name = args.name; if (args.color !== undefined) edits.color = args.color; if (args.hoist !== undefined) edits.hoist = args.hoist; if (args.mentionable !== undefined) edits.mentionable = args.mentionable; if (args.permissions) edits.permissions = args.permissions.map((p) => PermissionsBitField.Flags[p]).filter(Boolean); await role.edit(edits); return { id: role.id, name: role.name, edited: Object.keys(edits) }; }
    case "delete_role": { const role = guild.roles.cache.get(args.role_id); if (!role) throw new Error(`Role ${args.role_id} not found`); const roleName = role.name; await role.delete(); return { deleted: args.role_id, name: roleName }; }
    case "mass_create_role": { const results = await Promise.allSettled(args.roles.map((r) => guild.roles.create({ name: r.name, color: r.color || null, hoist: r.hoist || false, mentionable: r.mentionable || false }))); return results.map((r, i) => r.status === "fulfilled" ? { name: args.roles[i].name, id: r.value.id, status: "created" } : { name: args.roles[i].name, status: "failed", error: r.reason?.message }); }
    case "mass_delete_role": { const results = await Promise.allSettled(args.role_ids.map(async (id) => { const role = guild.roles.cache.get(id); if (!role) throw new Error(`Role ${id} not found`); const n = role.name; await role.delete(); return { id, name: n }; })); return results.map((r, i) => r.status === "fulfilled" ? { id: args.role_ids[i], name: r.value.name, status: "deleted" } : { id: args.role_ids[i], status: "failed", error: r.reason?.message }); }
    case "assign_role": { const member = await resolveMember(guild, args.user_id); const role = resolveRole(guild, args.role_id); await member.roles.add(role); return { user_id: member.id, username: member.user.username, role_id: role.id, role_name: role.name, status: "assigned" }; }
    case "remove_role": { const member = await resolveMember(guild, args.user_id); const role = resolveRole(guild, args.role_id); await member.roles.remove(role); return { user_id: member.id, username: member.user.username, role_id: role.id, role_name: role.name, status: "removed" }; }
    case "list_members": { const limit = Math.min(args.limit || 100, 1000); await guild.members.fetch({ limit }); let members = [...guild.members.cache.values()]; if (args.role_id) { const role = resolveRole(guild, args.role_id); members = members.filter((m) => m.roles.cache.has(role.id)); } return { guild_id: guild.id, total: members.length, members: members.slice(0, limit).map((m) => ({ id: m.id, username: m.user.username, display_name: m.displayName, is_bot: m.user.bot, joined_at: m.joinedAt, avatar_url: m.displayAvatarURL({ size: 256 }), roles: m.roles.cache.filter((r) => r.name !== "@everyone").map((r) => ({ id: r.id, name: r.name })) })) }; }
    case "get_member": { const member = await resolveMember(guild, args.user_id); return { id: member.id, username: member.user.username, display_name: member.displayName, nickname: member.nickname, avatar_url: member.displayAvatarURL({ size: 512 }), is_bot: member.user.bot, joined_at: member.joinedAt, account_created_at: member.user.createdAt, boosting_since: member.premiumSince, communication_disabled_until: member.communicationDisabledUntilTimestamp ? new Date(member.communicationDisabledUntilTimestamp) : null, roles: member.roles.cache.filter((r) => r.name !== "@everyone").sort((a, b) => b.position - a.position).map((r) => ({ id: r.id, name: r.name, color: r.hexColor })), permissions: member.permissions.toArray(), presence: member.presence ? { status: member.presence.status, activities: member.presence.activities.map((a) => ({ name: a.name, type: a.type, state: a.state })) } : null }; }
    case "set_nickname": { const member = await resolveMember(guild, args.user_id); const oldNick = member.nickname; await member.setNickname(args.nickname || null); return { user_id: member.id, username: member.user.username, old_nickname: oldNick, new_nickname: args.nickname || null }; }
    case "create_invite": { const channel = resolveAnyChannel(guild, args.channel_id); const invite = await channel.createInvite({ maxAge: args.max_age ?? 86400, maxUses: args.max_uses ?? 0, temporary: args.temporary ?? false, unique: args.unique ?? false }); return { code: invite.code, url: invite.url, channel_id: channel.id, max_age: invite.maxAge, max_uses: invite.maxUses, temporary: invite.temporary }; }
    case "list_invites": { const invites = await guild.invites.fetch(); return { total: invites.size, invites: [...invites.values()].map((i) => ({ code: i.code, url: i.url, channel: i.channel?.name, channel_id: i.channel?.id, inviter: i.inviter?.username, uses: i.uses, max_uses: i.maxUses, max_age: i.maxAge, temporary: i.temporary, created_at: i.createdAt })) }; }
    case "create_webhook": { const channel = await resolveTextChannel(guild, args.channel_id); const opts = { name: args.name }; if (args.avatar) opts.avatar = args.avatar; const webhook = await channel.createWebhook(opts); return { id: webhook.id, name: webhook.name, url: webhook.url, channel_id: channel.id, token: webhook.token }; }
    case "list_webhooks": { let webhooks; if (args.channel_id) { const channel = await resolveTextChannel(guild, args.channel_id); webhooks = await channel.fetchWebhooks(); } else { webhooks = await guild.fetchWebhooks(); } return { total: webhooks.size, webhooks: [...webhooks.values()].map((w) => ({ id: w.id, name: w.name, url: w.url, channel_id: w.channelId, channel_name: guild.channels.cache.get(w.channelId)?.name, creator: w.owner?.username })) }; }
    case "list_emojis": { await guild.emojis.fetch(); return { total: guild.emojis.cache.size, emojis: [...guild.emojis.cache.values()].map((e) => ({ id: e.id, name: e.name, animated: e.animated, url: e.imageURL(), identifier: e.toString(), created_at: e.createdAt, creator: e.author?.username })) }; }
    case "create_emoji": { const emoji = await guild.emojis.create({ name: args.name, attachment: args.image_url }); return { id: emoji.id, name: emoji.name, url: emoji.imageURL(), identifier: emoji.toString() }; }
    case "delete_emoji": { let emoji = guild.emojis.cache.get(args.emoji_id); if (!emoji) { const lower = args.emoji_id.toLowerCase(); emoji = guild.emojis.cache.find((e) => e.name.toLowerCase() === lower); } if (!emoji) throw new Error(`Emoji "${args.emoji_id}" not found`); const emojiName = emoji.name; await emoji.delete(); return { deleted: args.emoji_id, name: emojiName }; }
    case "get_audit_log": { const opts = { limit: Math.min(args.limit || 20, 100) }; if (args.action_type && AUDIT_LOG_ACTIONS[args.action_type] !== undefined) opts.type = AUDIT_LOG_ACTIONS[args.action_type]; if (args.user_id) opts.user = args.user_id; const auditLogs = await guild.fetchAuditLogs(opts); return { total: auditLogs.entries.size, entries: [...auditLogs.entries.values()].map((e) => ({ id: e.id, action: e.action, action_type: Object.entries(AUDIT_LOG_ACTIONS).find(([, v]) => v === e.action)?.[0] || String(e.action), executor: e.executor?.username, executor_id: e.executor?.id, target_id: e.targetId, reason: e.reason, created_at: e.createdAt, changes: e.changes?.map((c) => ({ key: c.key, old: c.old, new: c.new })) })) }; }
    case "server_analysis": { await guild.members.fetch(); const channels = guild.channels.cache; const members = guild.members.cache; const roles = guild.roles.cache; return { id: guild.id, name: guild.name, description: guild.description, owner_id: guild.ownerId, created_at: guild.createdAt, verification_level: guild.verificationLevel, member_count: guild.memberCount, humans: members.filter((m) => !m.user.bot).size, bots: members.filter((m) => m.user.bot).size, online_members: members.filter((m) => m.presence?.status && m.presence.status !== "offline").size, boost_level: guild.premiumTier, boost_count: guild.premiumSubscriptionCount, channels: { total: channels.size, text: channels.filter((c) => c.type === ChannelType.GuildText).size, voice: channels.filter((c) => c.type === ChannelType.GuildVoice).size, categories: channels.filter((c) => c.type === ChannelType.GuildCategory).size, forums: channels.filter((c) => c.type === ChannelType.GuildForum).size, announcement: channels.filter((c) => c.type === ChannelType.GuildAnnouncement).size, stage: channels.filter((c) => c.type === ChannelType.GuildStageVoice).size, list: channels.map((c) => ({ id: c.id, name: c.name, type: c.type })) }, roles: { total: roles.size, list: roles.filter((r) => r.name !== "@everyone").map((r) => ({ id: r.id, name: r.name, members: r.members.size, color: r.hexColor })) }, features: guild.features, icon_url: guild.iconURL(), banner_url: guild.bannerURL() }; }
    case "channel_analysis": { const channel = await resolveTextChannel(guild, args.channel_id); const limit = Math.min(args.limit || 100, 100); const messages = await channel.messages.fetch({ limit }); const authorMap = {}, wordFreq = {}; let totalWords = 0, totalChars = 0, hasAttachments = 0, hasEmbeds = 0, botMessages = 0; messages.forEach((msg) => { if (msg.author.bot) { botMessages++; return; } authorMap[msg.author.username] = (authorMap[msg.author.username] || 0) + 1; const words = msg.content.split(/\s+/).filter(Boolean); totalWords += words.length; totalChars += msg.content.length; words.forEach((w) => { const lw = w.toLowerCase().replace(/[^a-z0-9]/g, ""); if (lw.length > 2) wordFreq[lw] = (wordFreq[lw] || 0) + 1; }); if (msg.attachments.size > 0) hasAttachments++; if (msg.embeds.length > 0) hasEmbeds++; }); const humanMessages = messages.size - botMessages; return { channel_id: channel.id, channel_name: channel.name, topic: channel.topic, messages_analyzed: messages.size, human_messages: humanMessages, bot_messages: botMessages, date_range: { from: messages.last()?.createdAt, to: messages.first()?.createdAt }, total_words: totalWords, total_characters: totalChars, avg_words_per_message: (totalWords / (humanMessages || 1)).toFixed(2), messages_with_attachments: hasAttachments, messages_with_embeds: hasEmbeds, top_users: Object.entries(authorMap).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([user, count]) => ({ user, messages: count })), top_words: Object.entries(wordFreq).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([word, count]) => ({ word, count })) }; }
    case "user_analysis": { const member = await resolveMember(guild, args.user_id); const textChannels = guild.channels.cache.filter((c) => c.type === ChannelType.GuildText && c.viewable); const limit = Math.min(args.limit || 100, 200); const channelStats = [], recentMessages = [], wordFreq = {}; let totalMessages = 0, totalWords = 0; for (const [, channel] of textChannels) { try { const messages = await channel.messages.fetch({ limit }); const userMessages = messages.filter((m) => m.author.id === member.id); if (userMessages.size === 0) continue; totalMessages += userMessages.size; let chWords = 0; userMessages.forEach((msg) => { const words = msg.content.split(/\s+/).filter(Boolean); chWords += words.length; totalWords += words.length; words.forEach((w) => { const lw = w.toLowerCase().replace(/[^a-z0-9]/g, ""); if (lw.length > 2) wordFreq[lw] = (wordFreq[lw] || 0) + 1; }); if (recentMessages.length < 5) recentMessages.push({ content: msg.content.slice(0, 200), channel: channel.name, timestamp: msg.createdAt }); }); channelStats.push({ channel_name: channel.name, channel_id: channel.id, message_count: userMessages.size, words: chWords }); } catch {} } return { user_id: member.id, username: member.user.username, display_name: member.displayName, joined_at: member.joinedAt, account_created_at: member.user.createdAt, is_bot: member.user.bot, nickname: member.nickname, boosting_since: member.premiumSince, roles: member.roles.cache.filter((r) => r.name !== "@everyone").map((r) => ({ id: r.id, name: r.name })), total_messages_found: totalMessages, total_words: totalWords, avg_words_per_message: (totalWords / (totalMessages || 1)).toFixed(2), top_words: Object.entries(wordFreq).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([word, count]) => ({ word, count })), recent_messages: recentMessages, activity_by_channel: channelStats.sort((a, b) => b.message_count - a.message_count) }; }
    case "create_thread": { const channel = guild.channels.cache.get(args.channel_id); if (!channel) throw new Error(`Channel ${args.channel_id} not found`); const autoArchiveDuration = args.auto_archive_duration || 1440; let thread; if (args.message_id) { if (!channel.isTextBased()) throw new Error("Channel is not text-based"); const msg = await channel.messages.fetch(args.message_id); thread = await msg.startThread({ name: args.name, autoArchiveDuration, reason: args.reason || null }); } else { thread = await channel.threads.create({ name: args.name, autoArchiveDuration, reason: args.reason || null }); } return { thread_id: thread.id, name: thread.name, parent_id: thread.parentId, auto_archive_duration: thread.autoArchiveDuration, archived: thread.archived, locked: thread.locked }; }
    case "send_thread_message": { const thread = await fetchThread(guild, args.thread_id); const msg = await thread.send(args.content); return { message_id: msg.id, thread_id: args.thread_id, content: args.content }; }
    case "thread_analysis": { const thread = await fetchThread(guild, args.thread_id); const limit = Math.min(args.limit || 100, 100); const messages = await thread.messages.fetch({ limit }); const authorMap = {}, wordFreq = {}; let totalWords = 0, totalChars = 0, botMessages = 0; const allMessages = []; messages.forEach((msg) => { if (msg.author.bot) { botMessages++; return; } authorMap[msg.author.username] = (authorMap[msg.author.username] || 0) + 1; const words = msg.content.split(/\s+/).filter(Boolean); totalWords += words.length; totalChars += msg.content.length; words.forEach((w) => { const lw = w.toLowerCase().replace(/[^a-z0-9]/g, ""); if (lw.length > 2) wordFreq[lw] = (wordFreq[lw] || 0) + 1; }); allMessages.push({ author: msg.author.username, content: msg.content.slice(0, 500), timestamp: msg.createdAt }); }); const humanMessages = messages.size - botMessages; return { thread_id: thread.id, thread_name: thread.name, parent_channel_id: thread.parentId, archived: thread.archived, locked: thread.locked, messages_analyzed: messages.size, human_messages: humanMessages, bot_messages: botMessages, date_range: { from: messages.last()?.createdAt, to: messages.first()?.createdAt }, total_words: totalWords, total_characters: totalChars, avg_words_per_message: (totalWords / (humanMessages || 1)).toFixed(2), top_users: Object.entries(authorMap).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([user, count]) => ({ user, messages: count })), top_words: Object.entries(wordFreq).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([word, count]) => ({ word, count })), messages: allMessages.reverse() }; }
    case "list_threads": { const activeThreads = await guild.channels.fetchActiveThreads(); let threads = [...activeThreads.threads.values()]; if (args.channel_id) threads = threads.filter((t) => t.parentId === args.channel_id); const result = threads.map((t) => ({ thread_id: t.id, name: t.name, parent_channel_id: t.parentId, archived: t.archived, locked: t.locked, member_count: t.memberCount, message_count: t.messageCount, auto_archive_duration: t.autoArchiveDuration, created_at: t.createdAt })); if (args.include_archived && args.channel_id) { try { const parentChannel = guild.channels.cache.get(args.channel_id); if (parentChannel?.threads) { const archived = await parentChannel.threads.fetchArchived(); archived.threads.forEach((t) => result.push({ thread_id: t.id, name: t.name, parent_channel_id: t.parentId, archived: true, locked: t.locked, member_count: t.memberCount, message_count: t.messageCount, auto_archive_duration: t.autoArchiveDuration, created_at: t.createdAt })); } } catch {} } return { total: result.length, threads: result }; }
    case "archive_thread": { const thread = await fetchThread(guild, args.thread_id); const archived = args.archived !== undefined ? args.archived : true; const locked = args.locked || false; await thread.edit({ archived, locked }); return { thread_id: thread.id, name: thread.name, archived, locked }; }
    case "create_forum_post": { const channel = guild.channels.cache.get(args.channel_id) || guild.channels.cache.find((c) => c.name.toLowerCase() === args.channel_id.toLowerCase()); if (!channel) throw new Error(`Channel "${args.channel_id}" not found`); if (channel.type !== ChannelType.GuildForum) throw new Error(`Channel "${channel.name}" is not a Forum channel`); const messagePayload = buildMessagePayload({ content: args.content, embed: args.embed }); const thread = await channel.threads.create({ name: args.name, autoArchiveDuration: args.auto_archive_duration || 1440, message: messagePayload }); return { thread_id: thread.id, name: thread.name, parent_channel_id: thread.parentId, created_at: thread.createdAt }; }
    case "kick_user": { const member = await resolveMember(guild, args.user_id); await member.kick(args.reason || "No reason provided"); return { kicked: member.id, username: member.user.username, reason: args.reason || "No reason provided" }; }
    case "ban_user": { const member = await resolveMember(guild, args.user_id); await guild.members.ban(member.id, { reason: args.reason || "No reason provided", deleteMessageDays: args.delete_message_days || 0 }); return { banned: member.id, username: member.user.username, reason: args.reason || "No reason provided" }; }
    case "unban_user": { await guild.members.unban(args.user_id, args.reason || "No reason provided"); return { unbanned: args.user_id, reason: args.reason || "No reason provided" }; }
    case "list_bans": { const bans = await guild.bans.fetch({ limit: args.limit || 100 }); return { total: bans.size, bans: [...bans.values()].map((b) => ({ user_id: b.user.id, username: b.user.username, reason: b.reason })) }; }
    case "time_out_user": { const member = await resolveMember(guild, args.user_id); const ms = args.duration_minutes * 60 * 1000; await member.timeout(ms, args.reason || "No reason provided"); return { timed_out: member.id, username: member.user.username, duration_minutes: args.duration_minutes, until: new Date(Date.now() + ms), reason: args.reason || "No reason provided" }; }
    case "remove_timeout": { const member = await resolveMember(guild, args.user_id); await member.timeout(null); return { user_id: member.id, username: member.user.username, status: "timeout_removed" }; }
    case "mass_ban": { const results = await Promise.allSettled(args.user_ids.map((id) => guild.members.ban(id, { reason: args.reason || "Mass ban", deleteMessageDays: args.delete_message_days || 0 }))); return results.map((r, i) => r.status === "fulfilled" ? { user_id: args.user_ids[i], status: "banned" } : { user_id: args.user_ids[i], status: "failed", error: r.reason?.message }); }
    case "mass_time_out": { const ms = args.duration_minutes * 60 * 1000; const results = await Promise.allSettled(args.user_ids.map(async (id) => { const m = await resolveMember(guild, id); await m.timeout(ms, args.reason || "Mass timeout"); return m.user.username; })); return results.map((r, i) => r.status === "fulfilled" ? { user_id: args.user_ids[i], username: r.value, status: "timed_out", until: new Date(Date.now() + ms) } : { user_id: args.user_ids[i], status: "failed", error: r.reason?.message }); }
    case "list_scheduled_events": { const events = await guild.scheduledEvents.fetch(); return { total: events.size, events: [...events.values()].map((e) => ({ id: e.id, name: e.name, description: e.description, start_time: e.scheduledStartAt, end_time: e.scheduledEndAt, status: e.status, entity_type: e.entityType, channel_id: e.channelId, location: e.entityMetadata?.location, creator: e.creator?.username, user_count: e.userCount, image_url: e.coverImageURL() })) }; }
    case "create_scheduled_event": { const { GuildScheduledEventEntityType, GuildScheduledEventPrivacyLevel } = await import("discord.js"); const opts = { name: args.name, scheduledStartTime: args.start_time, privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly, description: args.description || undefined }; if (args.location) { opts.entityType = GuildScheduledEventEntityType.External; opts.entityMetadata = { location: args.location }; opts.scheduledEndTime = args.end_time; } else if (args.channel_id) { const ch = guild.channels.cache.get(args.channel_id); opts.entityType = ch?.type === ChannelType.GuildStageVoice ? GuildScheduledEventEntityType.StageInstance : GuildScheduledEventEntityType.Voice; opts.channel = args.channel_id; if (args.end_time) opts.scheduledEndTime = args.end_time; } else { throw new Error("Either 'location' (for external) or 'channel_id' (for voice/stage) is required"); } if (args.image_url) opts.image = args.image_url; const event = await guild.scheduledEvents.create(opts); return { id: event.id, name: event.name, start_time: event.scheduledStartAt, status: event.status }; }
    case "delete_scheduled_event": { const event = await guild.scheduledEvents.fetch(args.event_id); await event.delete(); return { deleted: args.event_id, name: event.name }; }
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    if (args.requests && BATCHABLE_TOOLS.has(name)) {
      const results = await Promise.allSettled(args.requests.map(async (req) => {
        const mergedArgs = { ...args, ...req };
        delete mergedArgs.requests;
        return await handleTool(name, mergedArgs);
      }));
      const batchResult = results.map((r, i) =>
        r.status === "fulfilled"
          ? { ...r.value, status: "success" }
          : { ...args.requests[i], status: "failed", error: r.reason?.message }
      );
      return { content: [{ type: "text", text: JSON.stringify(batchResult, null, 2) }] };
    }
    const result = await handleTool(name, args);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
