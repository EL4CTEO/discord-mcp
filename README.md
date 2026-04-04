# Discord MCP

Extensive Discord MCP server for Claude — **99 tools** with hybrid single/batch mode for autonomous task workflows. Manage channels, messages, roles, threads, members, webhooks, emojis, stickers, automod, invites, scheduled events, audit logs, DMs, polls, forum tags, and more.

**v4.0.0** — Fully hybrid: every action tool supports both single and batch (`requests` array) mode. 24 new tools: AutoMod, Stickers, DM operations, Polls, Advanced Analysis, Guild Management, Forum Tags.

## Hybrid Single/Batch Mode

Every action tool supports two call modes with one unified interface:

```json
// Single mode — pass params directly
{ "tool": "send_message", "channel_id": "123", "content": "Hello" }

// Batch mode — pass requests array, executes all in parallel
{
  "tool": "send_message",
  "guild_id": "999",
  "requests": [
    { "channel_id": "123", "content": "Hello #1" },
    { "channel_id": "456", "content": "Hello #2" },
    { "channel_id": "789", "content": "Hello #3" }
  ]
}
```

Batch mode returns an array of results, each with `status: "success"` or `status: "failed"` + `error`. Top-level params like `guild_id` are inherited by each batch item.

---

## Setup

### 1. Create a Discord Bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application → Bot
3. Enable these **Privileged Intents**: `Server Members`, `Message Content`, `Presence`
4. Copy the bot token
5. Invite the bot (replace `YOUR_CLIENT_ID`):

```
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=8544854581706231&integration_type=0&scope=bot
```

**Recommended:** `8544854581706231` (Administrator) — covers all 99 tools.

### 2. Install globally

```bash
npm install -g github:EL4CTEO/discord-mcp
```

### 3. Configure your client

#### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "discord": {
      "command": "npx",
      "args": ["-y", "--prefer-online", "github:EL4CTEO/discord-mcp"],
      "env": {
        "DISCORD_BOT_TOKEN": "YOUR_TOKEN"
      }
    }
  }
}
```

#### Claude Code (CLI)

```bash
claude mcp add discord -s user -- npx -y github:EL4CTEO/discord-mcp
export DISCORD_BOT_TOKEN="YOUR_TOKEN"  # add to shell profile
```

Or in `.mcp.json`:

```json
{
  "mcpServers": {
    "discord": {
      "command": "npx",
      "args": ["-y", "github:EL4CTEO/discord-mcp"],
      "env": { "DISCORD_BOT_TOKEN": "YOUR_TOKEN" }
    }
  }
}
```

---

## First Use

1. `list_guilds` → find your server
2. `set_guild <id>` → persists to disk, call once
3. `list_channels` → resolve channel names/IDs

---

## Tools (99 total)

**✓** = supports batch mode via `requests` array

### Guild (4)

| Tool | ✓ | Description |
|------|:-:|-------------|
| `set_guild` | | Persist default guild ID to disk. |
| `get_guild` | | Get persisted default guild ID. |
| `list_guilds` | | List all servers the bot is in. |
| `guild_info` | | Detailed guild metadata. |

### Channels (12)

| Tool | ✓ | Description |
|------|:-:|-------------|
| `list_channels` | | List all channels with IDs, names, types, topic, NSFW. |
| `create_channel` | ✓ | Create a text channel. |
| `create_category` | ✓ | Create a category. |
| `create_voice_channel` | ✓ | Create a voice channel. |
| `create_announcement_channel` | | Create an announcement channel. |
| `edit_channel` | ✓ | Edit any channel property. |
| `rename_channel` | ✓ | Rename a channel or category. |
| `set_channel_topic` | ✓ | Set or clear a channel topic. |
| `move_channel` | ✓ | Move channel to different category. |
| `clone_channel` | ✓ | Clone channel with all settings. |
| `set_channel_permissions` | | Set permission overwrites. |
| `delete` | ✓ | Delete a channel or category. |

### Messages (15)

| Tool | ✓ | Description |
|------|:-:|-------------|
| `send_message` | ✓ | Send message + optional embed. |
| `get_messages` | ✓ | Fetch recent messages with full attachments/embeds. |
| `get_message` | ✓ | Fetch single message with full details. |
| `search_messages` | ✓ | Search by keyword with attachments/embeds. |
| `reply_message` | ✓ | Reply to a message. |
| `edit_message` | ✓ | Edit a bot message. |
| `pin_message` | ✓ | Pin a message. |
| `unpin_message` | ✓ | Unpin a message. |
| `get_pinned_messages` | ✓ | Get all pinned messages with full content. |
| `delete_message` | ✓ | Delete a message. |
| `bulk_delete_messages` | | Delete up to 100 messages (Discord native API). |
| `add_reaction` | ✓ | Add emoji reaction. |
| `remove_reaction` | ✓ | Remove bot's reaction. |
| `get_reactions` | ✓ | Get users who reacted. |
| `crosspost_message` | ✓ | Publish announcement message. |

### DMs (6)

| Tool | ✓ | Description |
|------|:-:|-------------|
| `send_dm` | ✓ | Send DM by user ID. |
| `send_dm_by_username` | | Send DM by username. |
| `get_dm_history` | ✓ | Fetch DM history with full attachments/embeds. |
| `reply_dm` | ✓ | Reply to a specific DM message. |
| `edit_dm` | ✓ | Edit a bot DM message. |
| `delete_dm` | ✓ | Delete a bot DM message. |

### Roles (6)

| Tool | ✓ | Description |
|------|:-:|-------------|
| `list_roles` | | List roles with colors, positions, permissions. |
| `create_role` | ✓ | Create a role. |
| `edit_role` | ✓ | Edit role properties. |
| `delete_role` | ✓ | Delete a role. |
| `assign_role` | ✓ | Assign role to user. |
| `remove_role` | ✓ | Remove role from user. |

### Members (3)

| Tool | ✓ | Description |
|------|:-:|-------------|
| `list_members` | | List members with avatar URLs. |
| `get_member` | ✓ | Detailed member info. |
| `set_nickname` | ✓ | Set/clear nickname. |

### Invites (3)

| Tool | ✓ | Description |
|------|:-:|-------------|
| `create_invite` | ✓ | Create invite link. |
| `list_invites` | | List active invites. |
| `delete_invite` | | Revoke invite. |

### Webhooks (4)

| Tool | ✓ | Description |
|------|:-:|-------------|
| `create_webhook` | ✓ | Create webhook. |
| `list_webhooks` | | List webhooks. |
| `delete_webhook` | ✓ | Delete webhook. |
| `send_webhook_message` | ✓ | Send via webhook URL. |

### Emojis (3)

| Tool | ✓ | Description |
|------|:-:|-------------|
| `list_emojis` | | List custom emojis. |
| `create_emoji` | ✓ | Create emoji from URL. |
| `delete_emoji` | ✓ | Delete emoji. |

### Stickers (3) ✨ NEW

| Tool | ✓ | Description |
|------|:-:|-------------|
| `list_stickers` | | List custom stickers. |
| `create_sticker` | ✓ | Create sticker from URL. |
| `delete_sticker` | ✓ | Delete sticker. |

### AutoMod (4) ✨ NEW

| Tool | ✓ | Description |
|------|:-:|-------------|
| `list_automod_rules` | | List all automod rules. |
| `create_automod_rule` | ✓ | Create rule (Keyword, Spam, KeywordPreset, MentionSpam). |
| `edit_automod_rule` | ✓ | Edit existing rule. |
| `delete_automod_rule` | ✓ | Delete rule. |

### Threads (6)

| Tool | ✓ | Description |
|------|:-:|-------------|
| `create_thread` | ✓ | Create thread. |
| `send_thread_message` | ✓ | Send message in thread. |
| `list_threads` | | List active/archived threads. |
| `thread_analysis` | | Analyze thread activity. |
| `archive_thread` | ✓ | Archive/unarchive thread. |
| `create_forum_post` | | Create forum post. |

### Forum Tags (2) ✨ NEW

| Tool | ✓ | Description |
|------|:-:|-------------|
| `list_forum_tags` | | List tags in a forum channel. |
| `edit_forum_tags` | ✓ | Set available tags for a forum channel. |

### Moderation (6)

| Tool | ✓ | Description |
|------|:-:|-------------|
| `kick_user` | ✓ | Kick a user. |
| `ban_user` | ✓ | Ban a user. |
| `unban_user` | ✓ | Unban a user. |
| `list_bans` | | List banned users. |
| `time_out_user` | ✓ | Timeout a user. |
| `remove_timeout` | | Remove timeout. |

### Analysis (7)

| Tool | Description |
|------|-------------|
| `server_analysis` | Full server overview. |
| `channel_analysis` | Channel activity stats. |
| `user_analysis` | User activity stats. |
| `message_stats` | ✨ Messages/day, peak hours, media ratio. |
| `role_analysis` | ✨ Empty roles, members without roles, role overlap. |
| `emoji_usage` | ✨ Emoji frequency analysis (custom + unicode). |
| `inactive_members` | ✨ Find members inactive for N days. |

### Guild Management (3) ✨ NEW

| Tool | Description |
|------|-------------|
| `edit_guild` | Edit server name, icon, banner, description, system channel, etc. |
| `prune_members` | Prune inactive members (dry-run or real). |
| `get_vanity_url` | Get vanity URL and usage count. |

### Media & Attachments (2) ✨ NEW

| Tool | ✓ | Description |
|------|:-:|-------------|
| `download_attachment` | ✓ | Full metadata + URLs for all attachments on a message. |
| `get_avatar` | ✓ | User avatar/banner or guild icon/banner at any resolution. |

### Utilities (3) ✨ NEW

| Tool | ✓ | Description |
|------|:-:|-------------|
| `send_typing` | ✓ | Send typing indicator (~10s). |
| `send_poll` | ✓ | Send a poll with up to 10 answers. |
| `fetch_message_link` | ✓ | Generate jump-to-message URL. |

### Audit Log (1)

| Tool | Description |
|------|-------------|
| `get_audit_log` | Fetch audit log entries. Filter by action type or user. |

### Bot (2)

| Tool | Description |
|------|-------------|
| `bot_info` | Bot username, ID, avatar, guilds count, uptime, WS ping. |
| `set_bot_status` | Set presence: status + activity. |

### Scheduled Events (3)

| Tool | ✓ | Description |
|------|:-:|-------------|
| `list_scheduled_events` | | List all events. |
| `create_scheduled_event` | | Create event. |
| `delete_scheduled_event` | ✓ | Delete event. |

---

## Embed Support

`send_message`, `reply_message`, `edit_message`, `send_dm`, `reply_dm`, `edit_dm`, `send_dm_by_username`, and `create_forum_post` all support an optional `embed` object:

```json
{
  "title": "My Title",
  "description": "My description",
  "color": "#5865F2",
  "fields": [{ "name": "Field 1", "value": "Value 1", "inline": true }],
  "footer": "Footer text",
  "thumbnail": "https://example.com/thumb.png",
  "image": "https://example.com/image.png",
  "author": "Author Name",
  "timestamp": true
}
```

---

## Efficiency Tips

- **`set_guild` once** — persists to disk
- **Use batch mode** (`requests` array) instead of calling the same tool multiple times
- **Use `list_channels`** to find a channel ID, not `server_analysis`
- **Use `bulk_delete_messages`** for fast deletion of recent messages (<14 days)
- **Use `edit_channel`** instead of separate rename/topic/move calls
- **If you have a channel ID**, call `send_message` directly — no other calls needed first
- **Use `send_typing`** before long operations for better UX

---

## Required Bot Permissions

**Recommended:** `8544854581706231` (Administrator) — covers all 99 tools.

**Minimal:** `564386553359607` — see [permission table in v3.2.0 docs](https://github.com/EL4CTEO/discord-mcp/blob/v3.2.0/README.md) for per-tool breakdown. v4.0.0 additionally requires:
- `Manage Guild` for `edit_guild`, `prune_members`, `get_vanity_url`
- `Manage Emojis & Stickers` for `create_sticker`, `delete_sticker`
- `Manage Guild` (AutoMod) for `create_automod_rule`, `edit_automod_rule`, `delete_automod_rule`

**Privileged Intents:** Server Members, Message Content, Presence

---

## Gateway Intents

v4.0.0 uses 14 gateway intents:

`Guilds`, `GuildMembers`, `GuildMessages`, `MessageContent`, `GuildModeration`, `GuildPresences`, `GuildMessageReactions`, `DirectMessages`, `DirectMessageReactions`, `GuildInvites`, `GuildWebhooks`, `GuildScheduledEvents`, `GuildEmojisAndStickers`, `GuildIntegrations`
