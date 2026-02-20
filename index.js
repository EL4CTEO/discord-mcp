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
  ],
});

// Start Discord login in background — don't await it here
const discordReady = new Promise((resolve, reject) => {
  discord.once("ready", resolve);
  discord.once("error", reject);
  discord.login(BOT_TOKEN).catch(reject);
});

// Start MCP server immediately without waiting for Discord
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

const tools = [
  {
    name: "set_guild",
    description: "Set the default guild (server) ID so you don't need to specify it every time",
    inputSchema: {
      type: "object",
      properties: {
        guild_id: { type: "string", description: "The Discord server ID to set as default" },
      },
      required: ["guild_id"],
    },
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
  {
    name: "create_channel",
    description: "Create a single text channel in a guild",
    inputSchema: {
      type: "object",
      properties: {
        guild_id: { type: "string", description: "Discord server ID (optional if default is set)" },
        name: { type: "string" },
        category_id: { type: "string" },
        topic: { type: "string" },
      },
      required: ["name"],
    },
  },
  {
    name: "create_category",
    description: "Create a single category in a guild",
    inputSchema: {
      type: "object",
      properties: {
        guild_id: { type: "string", description: "Discord server ID (optional if default is set)" },
        name: { type: "string" },
      },
      required: ["name"],
    },
  },
  {
    name: "create_voice_channel",
    description: "Create a single voice channel in a guild",
    inputSchema: {
      type: "object",
      properties: {
        guild_id: { type: "string", description: "Discord server ID (optional if default is set)" },
        name: { type: "string" },
        category_id: { type: "string" },
        user_limit: { type: "number" },
      },
      required: ["name"],
    },
  },
  {
    name: "mass_channels",
    description: "Create multiple text channels in parallel",
    inputSchema: {
      type: "object",
      properties: {
        guild_id: { type: "string", description: "Discord server ID (optional if default is set)" },
        channels: {
          type: "array",
          items: {
            type: "object",
            properties: { name: { type: "string" }, category_id: { type: "string" }, topic: { type: "string" } },
            required: ["name"],
          },
        },
      },
      required: ["channels"],
    },
  },
  {
    name: "mass_categories",
    description: "Create multiple categories in parallel",
    inputSchema: {
      type: "object",
      properties: {
        guild_id: { type: "string", description: "Discord server ID (optional if default is set)" },
        names: { type: "array", items: { type: "string" } },
      },
      required: ["names"],
    },
  },
  {
    name: "mass_voice_channels",
    description: "Create multiple voice channels in parallel",
    inputSchema: {
      type: "object",
      properties: {
        guild_id: { type: "string", description: "Discord server ID (optional if default is set)" },
        channels: {
          type: "array",
          items: {
            type: "object",
            properties: { name: { type: "string" }, category_id: { type: "string" }, user_limit: { type: "number" } },
            required: ["name"],
          },
        },
      },
      required: ["channels"],
    },
  },
  {
    name: "delete",
    description: "Delete a single channel or category by ID",
    inputSchema: {
      type: "object",
      properties: {
        guild_id: { type: "string", description: "Discord server ID (optional if default is set)" },
        channel_id: { type: "string" },
      },
      required: ["channel_id"],
    },
  },
  {
    name: "mass_delete",
    description: "Delete multiple channels/categories in parallel",
    inputSchema: {
      type: "object",
      properties: {
        guild_id: { type: "string", description: "Discord server ID (optional if default is set)" },
        channel_ids: { type: "array", items: { type: "string" } },
      },
      required: ["channel_ids"],
    },
  },
  {
    name: "server_analysis",
    description: "Complete analysis of a Discord server",
    inputSchema: {
      type: "object",
      properties: {
        guild_id: { type: "string", description: "Discord server ID (optional if default is set)" },
      },
    },
  },
  {
    name: "channel_analysis",
    description: "Analyze a specific text channel",
    inputSchema: {
      type: "object",
      properties: {
        guild_id: { type: "string", description: "Discord server ID (optional if default is set)" },
        channel_id: { type: "string" },
        limit: { type: "number" },
      },
      required: ["channel_id"],
    },
  },
  {
    name: "user_analysis",
    description: "Analyze a user in a server",
    inputSchema: {
      type: "object",
      properties: {
        guild_id: { type: "string", description: "Discord server ID (optional if default is set)" },
        user_id: { type: "string" },
        limit: { type: "number" },
      },
      required: ["user_id"],
    },
  },
  {
    name: "ban_user",
    description: "Ban a single user from a guild",
    inputSchema: {
      type: "object",
      properties: {
        guild_id: { type: "string", description: "Discord server ID (optional if default is set)" },
        user_id: { type: "string" },
        reason: { type: "string" },
        delete_message_days: { type: "number" },
      },
      required: ["user_id"],
    },
  },
  {
    name: "time_out_user",
    description: "Timeout a single user",
    inputSchema: {
      type: "object",
      properties: {
        guild_id: { type: "string", description: "Discord server ID (optional if default is set)" },
        user_id: { type: "string" },
        duration_minutes: { type: "number" },
        reason: { type: "string" },
      },
      required: ["user_id", "duration_minutes"],
    },
  },
  {
    name: "mass_ban",
    description: "Ban multiple users in parallel",
    inputSchema: {
      type: "object",
      properties: {
        guild_id: { type: "string", description: "Discord server ID (optional if default is set)" },
        user_ids: { type: "array", items: { type: "string" } },
        reason: { type: "string" },
        delete_message_days: { type: "number" },
      },
      required: ["user_ids"],
    },
  },
  {
    name: "mass_time_out",
    description: "Timeout multiple users in parallel",
    inputSchema: {
      type: "object",
      properties: {
        guild_id: { type: "string", description: "Discord server ID (optional if default is set)" },
        user_ids: { type: "array", items: { type: "string" } },
        duration_minutes: { type: "number" },
        reason: { type: "string" },
      },
      required: ["user_ids", "duration_minutes"],
    },
  },
];

async function handleTool(name, args) {
  await requireDiscord();

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
        guilds: discord.guilds.cache.map((g) => ({
          id: g.id,
          name: g.name,
          member_count: g.memberCount,
          is_default: g.id === config.default_guild_id,
        })),
        default_guild_id: config.default_guild_id || null,
      };
    }
  }

  const guildId = resolveGuildId(args);
  const guild = getGuild(guildId);

  switch (name) {
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
      const channel = guild.channels.cache.get(args.channel_id);
      if (!channel) throw new Error(`Channel ${args.channel_id} not found`);
      if (!channel.isTextBased()) throw new Error("Channel is not text-based");
      const limit = Math.min(args.limit || 100, 500);
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
      const member = await guild.members.fetch(args.user_id);
      if (!member) throw new Error(`User ${args.user_id} not found`);
      const textChannels = guild.channels.cache.filter((c) => c.type === ChannelType.GuildText && c.viewable);
      const limit = Math.min(args.limit || 100, 200);
      const channelStats = [], recentMessages = [], wordFreq = {};
      let totalMessages = 0, totalWords = 0;
      for (const [, channel] of textChannels) {
        try {
          const messages = await channel.messages.fetch({ limit });
          const userMessages = messages.filter((m) => m.author.id === args.user_id);
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
    case "ban_user": {
      await guild.members.ban(args.user_id, { reason: args.reason || "No reason provided", deleteMessageDays: args.delete_message_days || 0 });
      return { banned: args.user_id, reason: args.reason || "No reason provided" };
    }
    case "time_out_user": {
      const member = await guild.members.fetch(args.user_id);
      const ms = args.duration_minutes * 60 * 1000;
      await member.timeout(ms, args.reason || "No reason provided");
      return { timed_out: args.user_id, username: member.user.username, duration_minutes: args.duration_minutes, until: new Date(Date.now() + ms), reason: args.reason || "No reason provided" };
    }
    case "mass_ban": {
      const results = await Promise.allSettled(args.user_ids.map((id) => guild.members.ban(id, { reason: args.reason || "Mass ban", deleteMessageDays: args.delete_message_days || 0 })));
      return results.map((r, i) => r.status === "fulfilled" ? { user_id: args.user_ids[i], status: "banned" } : { user_id: args.user_ids[i], status: "failed", error: r.reason?.message });
    }
    case "mass_time_out": {
      const ms = args.duration_minutes * 60 * 1000;
      const results = await Promise.allSettled(args.user_ids.map(async (id) => { const m = await guild.members.fetch(id); await m.timeout(ms, args.reason || "Mass timeout"); return m.user.username; }));
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
