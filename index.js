#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Client, GatewayIntentBits, ChannelType } from "discord.js";
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
  ],
});

const discordReady = new Promise((resolve, reject) => {
  discord.once("ready", resolve);
  discord.once("error", reject);
  discord.login(BOT_TOKEN).catch(reject);
});

const server = new Server(
  { name: "discord-mcp", version: "1.0.0" },
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

// Resolves snowflake ID OR username/displayName/globalName (case-insensitive)
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

// Resolves a role by ID or name (case-insensitive)
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

// Fetch a text-based channel or thread by ID
async function resolveTextChannel(guild, channelId) {
  let channel = guild.channels.cache.get(channelId);
  if (!channel) {
    try { channel = await discord.channels.fetch(channelId); } catch {}
  }
  if (!channel) {
    const activeThreads = await guild.channels.fetchActiveThreads();
    channel = activeThreads.threads.get(channelId);
  }
  if (!channel) throw new Error(`Channel/thread ${channelId} not found`);
  if (!channel.isTextBased()) throw new Error(`Channel ${channelId} is not text-based`);
  return channel;
}

// Fetch a thread by ID (active or archived)
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

const tools = [
  // ── GUILD ─────────────────────────────────────────────────────────────────
  {
    name: "set_guild",
    description: "Set the default guild (server) ID so you don't need to specify it every time",
    inputSchema: { type: "object", properties: { guild_id: { type: "string" } }, required: ["guild_id"] },
  },
  {
    name: "get_guild",
    description: "Get the currently set default guild ID",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_guilds",
    description: "List all Discord servers the bot is currently in",
    inputSchema: { type: "object", properties: {} },
  },

  // ── CHANNELS ──────────────────────────────────────────────────────────────
  {
    name: "create_channel",
    description: "Create a single text channel in a guild",
    inputSchema: { type: "object", properties: { guild_id: { type: "string" }, name: { type: "string" }, category_id: { type: "string" }, topic: { type: "string" } }, required: ["name"] },
  },
  {
    name: "create_category",
    description: "Create a single category in a guild",
    inputSchema: { type: "object", properties: { guild_id: { type: "string" }, name: { type: "string" } }, required: ["name"] },
  },
  {
    name: "create_voice_channel",
    description: "Create a single voice channel in a guild",
    inputSchema: { type: "object", properties: { guild_id: { type: "string" }, name: { type: "string" }, category_id: { type: "string" }, user_limit: { type: "number" } }, required: ["name"] },
  },
  {
    name: "mass_channels",
    description: "Create multiple text channels in parallel",
    inputSchema: { type: "object", properties: { guild_id: { type: "string" }, channels: { type: "array", items: { type: "object", properties: { name: { type: "string" }, category_id: { type: "string" }, topic: { type: "string" } }, required: ["name"] } } }, required: ["channels"] },
  },
  {
    name: "mass_categories",
    description: "Create multiple categories in parallel",
    inputSchema: { type: "object", properties: { guild_id: { type: "string" }, names: { type: "array", items: { type: "string" } } }, required: ["names"] },
  },
  {
    name: "mass_voice_channels",
    description: "Create multiple voice channels in parallel",
    inputSchema: { type: "object", properties: { guild_id: { type: "string" }, channels: { type: "array", items: { type: "object", properties: { name: { type: "string" }, category_id: { type: "string" }, user_limit: { type: "number" } }, required: ["name"] } } }, required: ["channels"] },
  },
  {
    name: "delete",
    description: "Delete a single channel or category by ID",
    inputSchema: { type: "object", properties: { guild_id: { type: "string" }, channel_id: { type: "string" } }, required: ["channel_id"] },
  },
  {
    name: "mass_delete",
    description: "Delete multiple channels/categories in parallel",
    inputSchema: { type: "object", properties: { guild_id: { type: "string" }, channel_ids: { type: "array", items: { type: "string" } } }, required: ["channel_ids"] },
  },

  // ── MESSAGES ──────────────────────────────────────────────────────────────
  {
    name: "get_messages",
    description: "Fetch recent messages from a channel or thread with full content — use this to read what people are saying",
    inputSchema: {
      type: "object",
      properties: {
        guild_id: { type: "string", description: "Discord server ID (optional if default is set)" },
        channel_id: { type: "string", description: "Channel or thread ID" },
        limit: { type: "number", description: "Number of messages to fetch (default: 20, max: 100)" },
        before_message_id: { type: "string", description: "Fetch messages before this message ID (for pagination)" },
      },
      required: ["channel_id"],
    },
  },
  {
    name: "send_message",
    description: "Send a message to a specific channel or thread",
    inputSchema: { type: "object", properties: { guild_id: { type: "string" }, channel_id: { type: "string" }, content: { type: "string" } }, required: ["channel_id", "content"] },
  },
  {
    name: "reply_message",
    description: "Reply to a specific message in a channel — creates a Discord reply that pings the original author",
    inputSchema: {
      type: "object",
      properties: {
        guild_id: { type: "string", description: "Discord server ID (optional if default is set)" },
        channel_id: { type: "string", description: "The channel or thread ID containing the message" },
        message_id: { type: "string", description: "The message ID to reply to" },
        content: { type: "string", description: "Reply content" },
        ping: { type: "boolean", description: "Whether to ping the original author (default: true)" },
      },
      required: ["channel_id", "message_id", "content"],
    },
  },
  {
    name: "edit_message",
    description: "Edit a message sent by the bot",
    inputSchema: {
      type: "object",
      properties: {
        guild_id: { type: "string" },
        channel_id: { type: "string" },
        message_id: { type: "string" },
        content: { type: "string" },
      },
      required: ["channel_id", "message_id", "content"],
    },
  },
  {
    name: "mass_send_message",
    description: "Send messages to multiple channels in parallel",
    inputSchema: { type: "object", properties: { guild_id: { type: "string" }, messages: { type: "array", items: { type: "object", properties: { channel_id: { type: "string" }, content: { type: "string" } }, required: ["channel_id", "content"] } } }, required: ["messages"] },
  },
  {
    name: "delete_message",
    description: "Delete a specific message from a channel",
    inputSchema: { type: "object", properties: { guild_id: { type: "string" }, channel_id: { type: "string" }, message_id: { type: "string" } }, required: ["channel_id", "message_id"] },
  },
  {
    name: "mass_delete_message",
    description: "Delete multiple messages from a channel in parallel",
    inputSchema: { type: "object", properties: { guild_id: { type: "string" }, channel_id: { type: "string" }, message_ids: { type: "array", items: { type: "string" } } }, required: ["channel_id", "message_ids"] },
  },
  {
    name: "add_reaction",
    description: "Add an emoji reaction to a message",
    inputSchema: {
      type: "object",
      properties: {
        guild_id: { type: "string" },
        channel_id: { type: "string", description: "Channel or thread ID containing the message" },
        message_id: { type: "string" },
        emoji: { type: "string", description: "Unicode emoji (e.g. '👍') or custom emoji ID (e.g. '<:name:id>')" },
      },
      required: ["channel_id", "message_id", "emoji"],
    },
  },

  // ── ROLES ─────────────────────────────────────────────────────────────────
  {
    name: "create_role",
    description: "Create a single role in a guild",
    inputSchema: { type: "object", properties: { guild_id: { type: "string" }, name: { type: "string" }, color: { type: "string" }, hoist: { type: "boolean" }, mentionable: { type: "boolean" } }, required: ["name"] },
  },
  {
    name: "delete_role",
    description: "Delete a single role from a guild",
    inputSchema: { type: "object", properties: { guild_id: { type: "string" }, role_id: { type: "string" } }, required: ["role_id"] },
  },
  {
    name: "mass_create_role",
    description: "Create multiple roles in parallel",
    inputSchema: { type: "object", properties: { guild_id: { type: "string" }, roles: { type: "array", items: { type: "object", properties: { name: { type: "string" }, color: { type: "string" }, hoist: { type: "boolean" }, mentionable: { type: "boolean" } }, required: ["name"] } } }, required: ["roles"] },
  },
  {
    name: "mass_delete_role",
    description: "Delete multiple roles in parallel",
    inputSchema: { type: "object", properties: { guild_id: { type: "string" }, role_ids: { type: "array", items: { type: "string" } } }, required: ["role_ids"] },
  },
  {
    name: "assign_role",
    description: "Assign a role to a user. Accepts username or snowflake ID for both user and role.",
    inputSchema: {
      type: "object",
      properties: {
        guild_id: { type: "string" },
        user_id: { type: "string", description: "User snowflake ID or username" },
        role_id: { type: "string", description: "Role snowflake ID or role name" },
      },
      required: ["user_id", "role_id"],
    },
  },
  {
    name: "remove_role",
    description: "Remove a role from a user. Accepts username or snowflake ID for both user and role.",
    inputSchema: {
      type: "object",
      properties: {
        guild_id: { type: "string" },
        user_id: { type: "string", description: "User snowflake ID or username" },
        role_id: { type: "string", description: "Role snowflake ID or role name" },
      },
      required: ["user_id", "role_id"],
    },
  },

  // ── ANALYSIS ──────────────────────────────────────────────────────────────
  {
    name: "server_analysis",
    description: "Complete analysis of a Discord server",
    inputSchema: { type: "object", properties: { guild_id: { type: "string" } } },
  },
  {
    name: "channel_analysis",
    description: "Analyze a specific text channel",
    inputSchema: { type: "object", properties: { guild_id: { type: "string" }, channel_id: { type: "string" }, limit: { type: "number" } }, required: ["channel_id"] },
  },
  {
    name: "user_analysis",
    description: "Analyze a user in a server. Accepts snowflake ID or username/display name.",
    inputSchema: { type: "object", properties: { guild_id: { type: "string" }, user_id: { type: "string" }, limit: { type: "number" } }, required: ["user_id"] },
  },

  // ── THREADS ───────────────────────────────────────────────────────────────
  {
    name: "create_thread",
    description: "Create a thread inside a text channel. Attach to a message or create standalone.",
    inputSchema: { type: "object", properties: { guild_id: { type: "string" }, channel_id: { type: "string" }, name: { type: "string" }, message_id: { type: "string" }, auto_archive_duration: { type: "number" }, reason: { type: "string" } }, required: ["channel_id", "name"] },
  },
  {
    name: "send_thread_message",
    description: "Send a message inside a thread",
    inputSchema: { type: "object", properties: { guild_id: { type: "string" }, thread_id: { type: "string" }, content: { type: "string" } }, required: ["thread_id", "content"] },
  },
  {
    name: "thread_analysis",
    description: "Read and analyze all messages in a thread",
    inputSchema: { type: "object", properties: { guild_id: { type: "string" }, thread_id: { type: "string" }, limit: { type: "number" } }, required: ["thread_id"] },
  },
  {
    name: "list_threads",
    description: "List active (and optionally archived) threads in a channel or guild",
    inputSchema: { type: "object", properties: { guild_id: { type: "string" }, channel_id: { type: "string" }, include_archived: { type: "boolean" } } },
  },
  {
    name: "archive_thread",
    description: "Archive or unarchive a thread",
    inputSchema: { type: "object", properties: { guild_id: { type: "string" }, thread_id: { type: "string" }, archived: { type: "boolean" }, locked: { type: "boolean" } }, required: ["thread_id"] },
  },

  // ── MODERATION ────────────────────────────────────────────────────────────
  {
    name: "kick_user",
    description: "Kick a user from the guild. Accepts snowflake ID or username.",
    inputSchema: { type: "object", properties: { guild_id: { type: "string" }, user_id: { type: "string" }, reason: { type: "string" } }, required: ["user_id"] },
  },
  {
    name: "ban_user",
    description: "Ban a user from the guild. Accepts snowflake ID or username.",
    inputSchema: { type: "object", properties: { guild_id: { type: "string" }, user_id: { type: "string" }, reason: { type: "string" }, delete_message_days: { type: "number" } }, required: ["user_id"] },
  },
  {
    name: "unban_user",
    description: "Unban a user from the guild by snowflake ID",
    inputSchema: { type: "object", properties: { guild_id: { type: "string" }, user_id: { type: "string" }, reason: { type: "string" } }, required: ["user_id"] },
  },
  {
    name: "time_out_user",
    description: "Timeout a user. Accepts snowflake ID or username.",
    inputSchema: { type: "object", properties: { guild_id: { type: "string" }, user_id: { type: "string" }, duration_minutes: { type: "number" }, reason: { type: "string" } }, required: ["user_id", "duration_minutes"] },
  },
  {
    name: "mass_ban",
    description: "Ban multiple users in parallel",
    inputSchema: { type: "object", properties: { guild_id: { type: "string" }, user_ids: { type: "array", items: { type: "string" } }, reason: { type: "string" }, delete_message_days: { type: "number" } }, required: ["user_ids"] },
  },
  {
    name: "mass_time_out",
    description: "Timeout multiple users in parallel",
    inputSchema: { type: "object", properties: { guild_id: { type: "string" }, user_ids: { type: "array", items: { type: "string" } }, duration_minutes: { type: "number" }, reason: { type: "string" } }, required: ["user_ids", "duration_minutes"] },
  },
];

async function handleTool(name, args) {
  await requireDiscord();

  // ── GUILD ────────────────────────────────────────────────────────────────
  switch (name) {
    case "set_guild": {
      const guild = getGuild(args.guild_id);
      const config = loadConfig();
      config.default_guild_id = args.guild_id;
      saveConfig(config);
      return { success: true, default_guild_id: args.guild_id, guild_name: guild.name };
    }
    case "get_guild": {
      const config = loadConfig();
      if (!config.default_guild_id) return { default_guild_id: null, message: "No default guild set. Use set_guild." };
      try {
        const guild = getGuild(config.default_guild_id);
        return { default_guild_id: config.default_guild_id, guild_name: guild.name, member_count: guild.memberCount };
      } catch {
        return { default_guild_id: config.default_guild_id, message: "Saved but bot may no longer be in this server" };
      }
    }
    case "list_guilds": {
      const config = loadConfig();
      return {
        guilds: discord.guilds.cache.map((g) => ({ id: g.id, name: g.name, member_count: g.memberCount, is_default: g.id === config.default_guild_id })),
        default_guild_id: config.default_guild_id || null,
      };
    }
  }

  const guildId = resolveGuildId(args);
  const guild = getGuild(guildId);

  switch (name) {
    // ── CHANNELS ──────────────────────────────────────────────────────────
    case "create_channel": {
      const ch = await guild.channels.create({ name: args.name, type: ChannelType.GuildText, parent: args.category_id || null, topic: args.topic || null });
      return { id: ch.id, name: ch.name, type: "text" };
    }
    case "create_category": {
      const cat = await guild.channels.create({ name: args.name, type: ChannelType.GuildCategory });
      return { id: cat.id, name: cat.name, type: "category" };
    }
    case "create_voice_channel": {
      const vc = await guild.channels.create({ name: args.name, type: ChannelType.GuildVoice, parent: args.category_id || null, userLimit: args.user_limit || 0 });
      return { id: vc.id, name: vc.name, type: "voice" };
    }
    case "mass_channels": {
      const results = await Promise.allSettled(args.channels.map((ch) => guild.channels.create({ name: ch.name, type: ChannelType.GuildText, parent: ch.category_id || null, topic: ch.topic || null })));
      return results.map((r, i) => r.status === "fulfilled" ? { name: args.channels[i].name, id: r.value.id, status: "created" } : { name: args.channels[i].name, status: "failed", error: r.reason?.message });
    }
    case "mass_categories": {
      const results = await Promise.allSettled(args.names.map((n) => guild.channels.create({ name: n, type: ChannelType.GuildCategory })));
      return results.map((r, i) => r.status === "fulfilled" ? { name: args.names[i], id: r.value.id, status: "created" } : { name: args.names[i], status: "failed", error: r.reason?.message });
    }
    case "mass_voice_channels": {
      const results = await Promise.allSettled(args.channels.map((ch) => guild.channels.create({ name: ch.name, type: ChannelType.GuildVoice, parent: ch.category_id || null, userLimit: ch.user_limit || 0 })));
      return results.map((r, i) => r.status === "fulfilled" ? { name: args.channels[i].name, id: r.value.id, status: "created" } : { name: args.channels[i].name, status: "failed", error: r.reason?.message });
    }
    case "delete": {
      const ch = guild.channels.cache.get(args.channel_id);
      if (!ch) throw new Error(`Channel ${args.channel_id} not found`);
      const chName = ch.name;
      await ch.delete();
      return { deleted: args.channel_id, name: chName };
    }
    case "mass_delete": {
      const results = await Promise.allSettled(args.channel_ids.map(async (id) => { const ch = guild.channels.cache.get(id); if (!ch) throw new Error(`Channel ${id} not found`); const n = ch.name; await ch.delete(); return { id, name: n }; }));
      return results.map((r, i) => r.status === "fulfilled" ? { id: args.channel_ids[i], name: r.value.name, status: "deleted" } : { id: args.channel_ids[i], status: "failed", error: r.reason?.message });
    }

    // ── MESSAGES ──────────────────────────────────────────────────────────
    case "get_messages": {
      const channel = await resolveTextChannel(guild, args.channel_id);
      const limit = Math.min(args.limit || 20, 100);
      const fetchOptions = { limit };
      if (args.before_message_id) fetchOptions.before = args.before_message_id;
      const messages = await channel.messages.fetch(fetchOptions);
      return {
        channel_id: channel.id,
        channel_name: channel.name,
        messages: [...messages.values()].reverse().map((m) => ({
          id: m.id,
          author: m.author.username,
          author_id: m.author.id,
          display_name: m.member?.displayName || m.author.username,
          content: m.content,
          timestamp: m.createdAt,
          edited: !!m.editedAt,
          attachments: m.attachments.size,
          embeds: m.embeds.length,
          reactions: m.reactions.cache.map((r) => ({ emoji: r.emoji.toString(), count: r.count })),
          reply_to: m.reference?.messageId || null,
        })),
      };
    }
    case "send_message": {
      const channel = await resolveTextChannel(guild, args.channel_id);
      const msg = await channel.send(args.content);
      return { message_id: msg.id, channel_id: args.channel_id, content: args.content };
    }
    case "reply_message": {
      const channel = await resolveTextChannel(guild, args.channel_id);
      const targetMsg = await channel.messages.fetch(args.message_id);
      const msg = await targetMsg.reply({ content: args.content, allowedMentions: { repliedUser: args.ping !== false } });
      return { message_id: msg.id, channel_id: args.channel_id, replied_to: args.message_id, content: args.content };
    }
    case "edit_message": {
      const channel = await resolveTextChannel(guild, args.channel_id);
      const msg = await channel.messages.fetch(args.message_id);
      await msg.edit(args.content);
      return { edited_message_id: args.message_id, channel_id: args.channel_id, new_content: args.content };
    }
    case "mass_send_message": {
      const results = await Promise.allSettled(args.messages.map(async (m) => {
        const channel = await resolveTextChannel(guild, m.channel_id);
        const msg = await channel.send(m.content);
        return { message_id: msg.id, channel_id: m.channel_id };
      }));
      return results.map((r, i) => r.status === "fulfilled" ? { channel_id: args.messages[i].channel_id, message_id: r.value.message_id, status: "sent" } : { channel_id: args.messages[i].channel_id, status: "failed", error: r.reason?.message });
    }
    case "delete_message": {
      const channel = await resolveTextChannel(guild, args.channel_id);
      const msg = await channel.messages.fetch(args.message_id);
      await msg.delete();
      return { deleted_message_id: args.message_id, channel_id: args.channel_id };
    }
    case "mass_delete_message": {
      const channel = await resolveTextChannel(guild, args.channel_id);
      const results = await Promise.allSettled(args.message_ids.map(async (id) => { const msg = await channel.messages.fetch(id); await msg.delete(); return id; }));
      return results.map((r, i) => r.status === "fulfilled" ? { message_id: args.message_ids[i], status: "deleted" } : { message_id: args.message_ids[i], status: "failed", error: r.reason?.message });
    }
    case "add_reaction": {
      const channel = await resolveTextChannel(guild, args.channel_id);
      const msg = await channel.messages.fetch(args.message_id);
      await msg.react(args.emoji);
      return { message_id: args.message_id, emoji: args.emoji, status: "reacted" };
    }

    // ── ROLES ─────────────────────────────────────────────────────────────
    case "create_role": {
      const role = await guild.roles.create({ name: args.name, color: args.color || null, hoist: args.hoist || false, mentionable: args.mentionable || false });
      return { id: role.id, name: role.name, color: role.hexColor, hoist: role.hoist, mentionable: role.mentionable };
    }
    case "delete_role": {
      const role = guild.roles.cache.get(args.role_id);
      if (!role) throw new Error(`Role ${args.role_id} not found`);
      const roleName = role.name;
      await role.delete();
      return { deleted: args.role_id, name: roleName };
    }
    case "mass_create_role": {
      const results = await Promise.allSettled(args.roles.map((r) => guild.roles.create({ name: r.name, color: r.color || null, hoist: r.hoist || false, mentionable: r.mentionable || false })));
      return results.map((r, i) => r.status === "fulfilled" ? { name: args.roles[i].name, id: r.value.id, status: "created" } : { name: args.roles[i].name, status: "failed", error: r.reason?.message });
    }
    case "mass_delete_role": {
      const results = await Promise.allSettled(args.role_ids.map(async (id) => { const role = guild.roles.cache.get(id); if (!role) throw new Error(`Role ${id} not found`); const n = role.name; await role.delete(); return { id, name: n }; }));
      return results.map((r, i) => r.status === "fulfilled" ? { id: args.role_ids[i], name: r.value.name, status: "deleted" } : { id: args.role_ids[i], status: "failed", error: r.reason?.message });
    }
    case "assign_role": {
      const member = await resolveMember(guild, args.user_id);
      const role = resolveRole(guild, args.role_id);
      await member.roles.add(role);
      return { user_id: member.id, username: member.user.username, role_id: role.id, role_name: role.name, status: "assigned" };
    }
    case "remove_role": {
      const member = await resolveMember(guild, args.user_id);
      const role = resolveRole(guild, args.role_id);
      await member.roles.remove(role);
      return { user_id: member.id, username: member.user.username, role_id: role.id, role_name: role.name, status: "removed" };
    }

    // ── ANALYSIS ──────────────────────────────────────────────────────────
    case "server_analysis": {
      await guild.members.fetch();
      const channels = guild.channels.cache;
      const members = guild.members.cache;
      const roles = guild.roles.cache;
      return {
        id: guild.id, name: guild.name, description: guild.description, owner_id: guild.ownerId,
        created_at: guild.createdAt, verification_level: guild.verificationLevel,
        member_count: guild.memberCount,
        humans: members.filter((m) => !m.user.bot).size,
        bots: members.filter((m) => m.user.bot).size,
        online_members: members.filter((m) => m.presence?.status && m.presence.status !== "offline").size,
        boost_level: guild.premiumTier, boost_count: guild.premiumSubscriptionCount,
        channels: { total: channels.size, text: channels.filter((c) => c.type === ChannelType.GuildText).size, voice: channels.filter((c) => c.type === ChannelType.GuildVoice).size, categories: channels.filter((c) => c.type === ChannelType.GuildCategory).size, list: channels.map((c) => ({ id: c.id, name: c.name, type: c.type })) },
        roles: { total: roles.size, list: roles.filter((r) => r.name !== "@everyone").map((r) => ({ id: r.id, name: r.name, members: r.members.size, color: r.hexColor })) },
        features: guild.features, icon_url: guild.iconURL(), banner_url: guild.bannerURL(),
      };
    }
    case "channel_analysis": {
      const channel = await resolveTextChannel(guild, args.channel_id);
      const limit = Math.min(args.limit || 100, 100);
      const messages = await channel.messages.fetch({ limit });
      const authorMap = {}, wordFreq = {};
      let totalWords = 0, totalChars = 0, hasAttachments = 0, hasEmbeds = 0, botMessages = 0;
      messages.forEach((msg) => {
        if (msg.author.bot) { botMessages++; return; }
        authorMap[msg.author.username] = (authorMap[msg.author.username] || 0) + 1;
        const words = msg.content.split(/\s+/).filter(Boolean);
        totalWords += words.length; totalChars += msg.content.length;
        words.forEach((w) => { const lw = w.toLowerCase().replace(/[^a-z0-9]/g, ""); if (lw.length > 2) wordFreq[lw] = (wordFreq[lw] || 0) + 1; });
        if (msg.attachments.size > 0) hasAttachments++;
        if (msg.embeds.length > 0) hasEmbeds++;
      });
      const humanMessages = messages.size - botMessages;
      return {
        channel_id: channel.id, channel_name: channel.name, topic: channel.topic,
        messages_analyzed: messages.size, human_messages: humanMessages, bot_messages: botMessages,
        date_range: { from: messages.last()?.createdAt, to: messages.first()?.createdAt },
        total_words: totalWords, total_characters: totalChars,
        avg_words_per_message: (totalWords / (humanMessages || 1)).toFixed(2),
        messages_with_attachments: hasAttachments, messages_with_embeds: hasEmbeds,
        top_users: Object.entries(authorMap).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([user, count]) => ({ user, messages: count })),
        top_words: Object.entries(wordFreq).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([word, count]) => ({ word, count })),
      };
    }
    case "user_analysis": {
      const member = await resolveMember(guild, args.user_id);
      const textChannels = guild.channels.cache.filter((c) => c.type === ChannelType.GuildText && c.viewable);
      const limit = Math.min(args.limit || 100, 200);
      const channelStats = [], recentMessages = [], wordFreq = {};
      let totalMessages = 0, totalWords = 0;
      for (const [, channel] of textChannels) {
        try {
          const messages = await channel.messages.fetch({ limit });
          const userMessages = messages.filter((m) => m.author.id === member.id);
          if (userMessages.size === 0) continue;
          totalMessages += userMessages.size;
          let chWords = 0;
          userMessages.forEach((msg) => {
            const words = msg.content.split(/\s+/).filter(Boolean);
            chWords += words.length; totalWords += words.length;
            words.forEach((w) => { const lw = w.toLowerCase().replace(/[^a-z0-9]/g, ""); if (lw.length > 2) wordFreq[lw] = (wordFreq[lw] || 0) + 1; });
            if (recentMessages.length < 5) recentMessages.push({ content: msg.content.slice(0, 200), channel: channel.name, timestamp: msg.createdAt });
          });
          channelStats.push({ channel_name: channel.name, channel_id: channel.id, message_count: userMessages.size, words: chWords });
        } catch {}
      }
      return {
        user_id: member.id, username: member.user.username, display_name: member.displayName,
        joined_at: member.joinedAt, account_created_at: member.user.createdAt,
        is_bot: member.user.bot, nickname: member.nickname, boosting_since: member.premiumSince,
        roles: member.roles.cache.filter((r) => r.name !== "@everyone").map((r) => ({ id: r.id, name: r.name })),
        total_messages_found: totalMessages, total_words: totalWords,
        avg_words_per_message: (totalWords / (totalMessages || 1)).toFixed(2),
        top_words: Object.entries(wordFreq).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([word, count]) => ({ word, count })),
        recent_messages: recentMessages,
        activity_by_channel: channelStats.sort((a, b) => b.message_count - a.message_count),
      };
    }

    // ── THREADS ───────────────────────────────────────────────────────────
    case "create_thread": {
      const channel = guild.channels.cache.get(args.channel_id);
      if (!channel) throw new Error(`Channel ${args.channel_id} not found`);
      const autoArchiveDuration = args.auto_archive_duration || 1440;
      let thread;
      if (args.message_id) {
        if (!channel.isTextBased()) throw new Error("Channel is not text-based");
        const msg = await channel.messages.fetch(args.message_id);
        thread = await msg.startThread({ name: args.name, autoArchiveDuration, reason: args.reason || null });
      } else {
        thread = await channel.threads.create({ name: args.name, autoArchiveDuration, reason: args.reason || null });
      }
      return { thread_id: thread.id, name: thread.name, parent_id: thread.parentId, auto_archive_duration: thread.autoArchiveDuration, archived: thread.archived, locked: thread.locked };
    }
    case "send_thread_message": {
      const thread = await fetchThread(guild, args.thread_id);
      const msg = await thread.send(args.content);
      return { message_id: msg.id, thread_id: args.thread_id, content: args.content };
    }
    case "thread_analysis": {
      const thread = await fetchThread(guild, args.thread_id);
      const limit = Math.min(args.limit || 100, 100);
      const messages = await thread.messages.fetch({ limit });
      const authorMap = {}, wordFreq = {};
      let totalWords = 0, totalChars = 0, botMessages = 0;
      const allMessages = [];
      messages.forEach((msg) => {
        if (msg.author.bot) { botMessages++; return; }
        authorMap[msg.author.username] = (authorMap[msg.author.username] || 0) + 1;
        const words = msg.content.split(/\s+/).filter(Boolean);
        totalWords += words.length; totalChars += msg.content.length;
        words.forEach((w) => { const lw = w.toLowerCase().replace(/[^a-z0-9]/g, ""); if (lw.length > 2) wordFreq[lw] = (wordFreq[lw] || 0) + 1; });
        allMessages.push({ author: msg.author.username, content: msg.content.slice(0, 500), timestamp: msg.createdAt });
      });
      const humanMessages = messages.size - botMessages;
      return {
        thread_id: thread.id, thread_name: thread.name,
        parent_channel_id: thread.parentId, archived: thread.archived, locked: thread.locked,
        messages_analyzed: messages.size, human_messages: humanMessages, bot_messages: botMessages,
        date_range: { from: messages.last()?.createdAt, to: messages.first()?.createdAt },
        total_words: totalWords, total_characters: totalChars,
        avg_words_per_message: (totalWords / (humanMessages || 1)).toFixed(2),
        top_users: Object.entries(authorMap).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([user, count]) => ({ user, messages: count })),
        top_words: Object.entries(wordFreq).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([word, count]) => ({ word, count })),
        messages: allMessages.reverse(),
      };
    }
    case "list_threads": {
      const activeThreads = await guild.channels.fetchActiveThreads();
      let threads = [...activeThreads.threads.values()];
      if (args.channel_id) threads = threads.filter((t) => t.parentId === args.channel_id);
      const result = threads.map((t) => ({ thread_id: t.id, name: t.name, parent_channel_id: t.parentId, archived: t.archived, locked: t.locked, member_count: t.memberCount, message_count: t.messageCount, auto_archive_duration: t.autoArchiveDuration, created_at: t.createdAt }));
      if (args.include_archived && args.channel_id) {
        try {
          const parentChannel = guild.channels.cache.get(args.channel_id);
          if (parentChannel?.threads) {
            const archived = await parentChannel.threads.fetchArchived();
            archived.threads.forEach((t) => result.push({ thread_id: t.id, name: t.name, parent_channel_id: t.parentId, archived: true, locked: t.locked, member_count: t.memberCount, message_count: t.messageCount, auto_archive_duration: t.autoArchiveDuration, created_at: t.createdAt }));
          }
        } catch {}
      }
      return { total: result.length, threads: result };
    }
    case "archive_thread": {
      const thread = await fetchThread(guild, args.thread_id);
      const archived = args.archived !== undefined ? args.archived : true;
      const locked = args.locked || false;
      await thread.edit({ archived, locked });
      return { thread_id: thread.id, name: thread.name, archived, locked };
    }

    // ── MODERATION ────────────────────────────────────────────────────────
    case "kick_user": {
      const member = await resolveMember(guild, args.user_id);
      await member.kick(args.reason || "No reason provided");
      return { kicked: member.id, username: member.user.username, reason: args.reason || "No reason provided" };
    }
    case "ban_user": {
      const member = await resolveMember(guild, args.user_id);
      await guild.members.ban(member.id, { reason: args.reason || "No reason provided", deleteMessageDays: args.delete_message_days || 0 });
      return { banned: member.id, username: member.user.username, reason: args.reason || "No reason provided" };
    }
    case "unban_user": {
      await guild.members.unban(args.user_id, args.reason || "No reason provided");
      return { unbanned: args.user_id, reason: args.reason || "No reason provided" };
    }
    case "time_out_user": {
      const member = await resolveMember(guild, args.user_id);
      const ms = args.duration_minutes * 60 * 1000;
      await member.timeout(ms, args.reason || "No reason provided");
      return { timed_out: member.id, username: member.user.username, duration_minutes: args.duration_minutes, until: new Date(Date.now() + ms), reason: args.reason || "No reason provided" };
    }
    case "mass_ban": {
      const results = await Promise.allSettled(args.user_ids.map((id) => guild.members.ban(id, { reason: args.reason || "Mass ban", deleteMessageDays: args.delete_message_days || 0 })));
      return results.map((r, i) => r.status === "fulfilled" ? { user_id: args.user_ids[i], status: "banned" } : { user_id: args.user_ids[i], status: "failed", error: r.reason?.message });
    }
    case "mass_time_out": {
      const ms = args.duration_minutes * 60 * 1000;
      const results = await Promise.allSettled(args.user_ids.map(async (id) => { const m = await resolveMember(guild, id); await m.timeout(ms, args.reason || "Mass timeout"); return m.user.username; }));
      return results.map((r, i) => r.status === "fulfilled" ? { user_id: args.user_ids[i], username: r.value, status: "timed_out", until: new Date(Date.now() + ms) } : { user_id: args.user_ids[i], status: "failed", error: r.reason?.message });
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    const result = await handleTool(name, args);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
