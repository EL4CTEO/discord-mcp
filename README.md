# Discord MCP

Extensive Discord MCP server for Claude — **84 tools** optimized for autonomous task workflows. Manage channels, messages, roles, threads, members, webhooks, emojis, invites, scheduled events, audit logs, DMs, and more with both single and mass parallel operations.

## Setup

### 1. Create a Discord Bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application → Bot
3. Enable these **Privileged Intents**:
   - `Server Members Intent`
   - `Message Content Intent`
   - `Presence Intent`
4. Copy the bot token
5. Invite the bot (replace `YOUR_CLIENT_ID`):

```
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=8544854581706231&integration_type=0&scope=bot
```

**Required permissions (Administrator):**

The recommended permission integer is **`8544854581706231`** (Administrator). This covers all 84 tools with a single permission. Alternatively, you can use the minimal set below:

| Permission | Used by |
|-----------|---------|
| Create Instant Invite | `create_invite` |
| Kick Members | `kick_user` |
| Ban Members | `ban_user`, `unban_user`, `list_bans`, `mass_ban` |
| Manage Channels | `create/delete/edit/clone/rename/move channels`, `set_channel_permissions` |
| Manage Guild | `list_invites`, `delete_invite` |
| Add Reactions | `add_reaction`, `remove_reaction` |
| View Audit Log | `get_audit_log` |
| View Channel | All read operations |
| Send Messages | `send_message`, `reply_message`, `mass_send_message`, DMs |
| Manage Messages | `delete_message`, `bulk_delete_messages` |
| Pin Messages | `pin_message`, `unpin_message` |
| Embed Links | Message embeds (`send_message`, `reply_message`, `edit_message`, DMs) |
| Read Message History | `get_messages`, `search_messages`, `channel_analysis`, `user_analysis` |
| Mention Everyone | `@everyone` / `@here` in messages |
| Use External Emojis | External emojis in messages |
| Change Nickname | `set_nickname` (self) |
| Manage Nicknames | `set_nickname` (other members) |
| Manage Roles | `create/edit/delete roles`, `assign_role`, `remove_role` |
| Manage Webhooks | `create/list/delete webhooks` |
| Manage Emojis & Stickers | `create/delete emojis` |
| Manage Events | `create/delete scheduled events` |
| Manage Threads | `archive_thread`, thread management |
| Create Public Threads | `create_thread`, `create_forum_post` |
| Send Messages in Threads | `send_thread_message` |
| Moderate Members | `time_out_user`, `remove_timeout`, `mass_time_out` |

### 2. Install globally

```bash
npm install -g github:EL4CTEO/discord-mcp
```

### 3. Configure your client

#### Claude Desktop

Add to your `claude_desktop_config.json`:

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

Config locations:
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

> **Tip:** Global install is recommended over `npx` to avoid startup timeouts.

#### Claude Code (CLI)

Add as a **user-scoped** MCP server (available across all projects):

```bash
claude mcp add discord -s user -- npx -y github:EL4CTEO/discord-mcp
```

Then set the bot token as an environment variable. Add this to your shell profile (`~/.bashrc`, `~/.zshrc`, or `~/.profile`):

```bash
export DISCORD_BOT_TOKEN="YOUR_TOKEN"
```

Or, if you prefer **project-scoped** (only available in the current project):

```bash
claude mcp add discord -- npx -y github:EL4CTEO/discord-mcp
```

You can also add it directly to your `.mcp.json` file (project root or `~/.claude/.mcp.json` for user scope):

```json
{
  "mcpServers": {
    "discord": {
      "command": "npx",
      "args": ["-y", "github:EL4CTEO/discord-mcp"],
      "env": {
        "DISCORD_BOT_TOKEN": "YOUR_TOKEN"
      }
    }
  }
}
```

To verify it's connected:

```bash
claude mcp list
```

---

## First Use

1. **List servers:** `list_guilds`
2. **Set default server** (persists to disk — once only): `set_guild 123456789012345678`
3. **List channels:** `list_channels`

After `set_guild`, you never need to specify `guild_id` again.

---

## Tools (84 total)

### Guild (4)

| Tool | Description |
|------|-------------|
| `set_guild` | Persist a default guild ID to disk. Call once — survives restarts. |
| `get_guild` | Get the currently persisted default guild ID. |
| `list_guilds` | List all servers the bot is in. |
| `guild_info` | Detailed guild metadata: icon, banner, features, verification level, vanity URL, AFK settings, boost info, NSFW level. |

### Channels (20)

| Tool | Description |
|------|-------------|
| `list_channels` | List all channels with IDs, names, types (text, voice, category, forum, announcement, stage), and categories. |
| `create_channel` | Create a text channel (supports NSFW, slowmode, topic, category). |
| `create_category` | Create a category. |
| `create_voice_channel` | Create a voice channel (supports bitrate, user limit). |
| `create_announcement_channel` | Create an announcement (news) channel. Requires Community-enabled guild. |
| `edit_channel` | Edit any channel property: name, topic, NSFW, slowmode, bitrate, user_limit, position, parent category, lock permissions. |
| `rename_channel` | Rename a channel or category. |
| `set_channel_topic` | Set or clear a text channel's topic. |
| `move_channel` | Move a channel into a different category. |
| `clone_channel` | Clone a channel with all settings (permissions, topic, slowmode, etc.). |
| `set_channel_permissions` | Set permission overwrites for a role or user on a channel. |
| `mass_channels` | Create multiple text channels in parallel. |
| `mass_categories` | Create multiple categories in parallel. |
| `mass_voice_channels` | Create multiple voice channels in parallel. |
| `delete` | Delete a channel or category by ID. |
| `mass_delete` | Delete multiple channels/categories in parallel. |

### Messages (20)

| Tool | Description |
|------|-------------|
| `send_message` | Send a message (+ optional embed) to a channel. Accepts channel name or ID. |
| `get_messages` | Fetch recent messages (default 20, max 100). Supports pagination. |
| `get_message` | Fetch a single message by ID (includes full embed/attachment details). |
| `search_messages` | Search for messages containing a keyword in a channel. |
| `reply_message` | Reply to a specific message with optional ping control. |
| `edit_message` | Edit a bot message. |
| `pin_message` | Pin a message. |
| `unpin_message` | Unpin a message. |
| `get_pinned_messages` | Get all pinned messages in a channel. |
| `delete_message` | Delete a specific message. |
| `bulk_delete_messages` | Delete up to 100 messages at once (messages must be <14 days old). |
| `mass_send_message` | Send messages to multiple channels in parallel. |
| `mass_delete_message` | Delete multiple messages in parallel. |
| `add_reaction` | Add an emoji reaction to a message. |
| `remove_reaction` | Remove the bot's reaction from a message. |
| `get_reactions` | Get users who reacted with a specific emoji. |
| `crosspost_message` | Publish a message in an announcement channel to all followers. |
| `send_dm` | Send a DM to a user by snowflake ID. |
| `send_dm_by_username` | Send a DM to a user by username or display name. |
| `get_dm_history` | Fetch DM conversation history between the bot and a user. |

### Roles (8)

| Tool | Description |
|------|-------------|
| `list_roles` | List all roles with IDs, names, colors, positions, and member counts. |
| `create_role` | Create a role (with optional color, hoist, mentionable, permissions). |
| `edit_role` | Edit a role's properties: name, color, hoist, mentionable, permissions. |
| `delete_role` | Delete a role by ID. |
| `mass_create_role` | Create multiple roles in parallel. |
| `mass_delete_role` | Delete multiple roles in parallel. |
| `assign_role` | Assign a role to a user. Accepts username or snowflake ID. |
| `remove_role` | Remove a role from a user. |

### Members (3)

| Tool | Description |
|------|-------------|
| `list_members` | List guild members. Supports role filter and limit. |
| `get_member` | Detailed member info: roles, permissions, join date, boost status, presence, timeout status. |
| `set_nickname` | Set or clear a member's nickname. |

### Invites (3)

| Tool | Description |
|------|-------------|
| `create_invite` | Create an invite link (configurable max age, max uses, temporary). |
| `list_invites` | List all active invites for the guild. |
| `delete_invite` | Revoke an invite by its code. |

### Webhooks (4)

| Tool | Description |
|------|-------------|
| `create_webhook` | Create a webhook for a channel. |
| `list_webhooks` | List webhooks for a channel or the entire guild. |
| `delete_webhook` | Delete a webhook by ID. |
| `send_webhook_message` | Send a message via webhook URL (custom username and avatar per message). |

### Emojis (3)

| Tool | Description |
|------|-------------|
| `list_emojis` | List all custom emojis in the guild. |
| `create_emoji` | Create a custom emoji from a URL. |
| `delete_emoji` | Delete a custom emoji by ID or name. |

### Audit Log (1)

| Tool | Description |
|------|-------------|
| `get_audit_log` | Fetch audit log entries. Filter by action type (CHANNEL_CREATE, MEMBER_KICK, MESSAGE_DELETE, etc.) or user. |

### Threads (6)

| Tool | Description |
|------|-------------|
| `create_thread` | Create a thread in a channel, optionally attached to a message. |
| `send_thread_message` | Send a message inside a thread. |
| `list_threads` | List active (and optionally archived) threads. |
| `thread_analysis` | Analyze thread: participants, word frequency, full history. |
| `archive_thread` | Archive/unarchive and optionally lock a thread. |
| `create_forum_post` | Create a new post in a Forum channel. |

### Analysis (3)

| Tool | Description |
|------|-------------|
| `server_analysis` | Full server overview: members, channels, roles, boosts, features. |
| `channel_analysis` | Channel stats: top users, top words, message volume, attachments. |
| `user_analysis` | User stats: messages per channel, top words, roles, recent messages. |

### Moderation (8)

| Tool | Description |
|------|-------------|
| `kick_user` | Kick a user. |
| `ban_user` | Ban a user. |
| `unban_user` | Unban a user by snowflake ID. |
| `list_bans` | List all banned users in the guild. |
| `time_out_user` | Timeout a user for N minutes. |
| `remove_timeout` | Remove a timeout from a user. |
| `mass_ban` | Ban multiple users in parallel. |
| `mass_time_out` | Timeout multiple users in parallel. |

### Bot (2)

| Tool | Description |
|------|-------------|
| `bot_info` | Get bot info: username, ID, avatar, guilds count, uptime, WS ping. |
| `set_bot_status` | Set the bot's presence: status (online/idle/dnd/invisible) and activity (Playing/Streaming/Listening/Watching/Competing). |

### Scheduled Events (3)

| Tool | Description |
|------|-------------|
| `list_scheduled_events` | List all scheduled events in the guild. |
| `create_scheduled_event` | Create a scheduled event (external location or voice/stage channel). |
| `delete_scheduled_event` | Delete a scheduled event by ID. |

---

## Embed Support

`send_message`, `reply_message`, `edit_message`, `mass_send_message`, `send_dm`, `send_dm_by_username`, and `create_forum_post` all support an optional `embed` object:

```json
{
  "title": "My Title",
  "description": "My description",
  "color": "#5865F2",
  "fields": [
    { "name": "Field 1", "value": "Value 1", "inline": true }
  ],
  "footer": "Footer text",
  "thumbnail": "https://example.com/thumb.png",
  "image": "https://example.com/image.png",
  "author": "Author Name",
  "timestamp": true
}
```

---

## Efficiency Tips

- **`set_guild` once** — it persists to disk
- **Use `list_channels`** to find a channel ID, not `server_analysis`
- **Use `list_roles`** to find a role ID, not `server_analysis`
- **Channel name resolution** — most tools accept channel name or ID directly
- **Use `mass_*` tools** when operating on multiple targets — they run in parallel
- **Use `bulk_delete_messages`** for fast deletion of recent messages
- **Use `edit_channel`** instead of separate rename/topic/move calls when editing multiple properties
- **If you have a channel ID**, call `send_message` directly with no other calls first

---

## Required Bot Permissions

**Recommended permission integer:** `8544854581706231` (Administrator)

This single permission covers all 84 tools. If you prefer minimal permissions, use **`564386553359607`** with the table below:

| Permission | Used by |
|-----------|---------|
| Create Instant Invite | `create_invite` |
| Kick Members | `kick_user` |
| Ban Members | `ban_user`, `unban_user`, `list_bans`, `mass_ban` |
| Manage Channels | Channel CRUD, `set_channel_permissions` |
| Manage Guild | `list_invites`, `delete_invite` |
| Add Reactions | `add_reaction`, `remove_reaction` |
| View Audit Log | `get_audit_log` |
| View Channel | All read operations |
| Send Messages | `send_message`, `reply_message`, `mass_send_message`, DMs |
| Manage Messages | `delete_message`, `bulk_delete_messages` |
| Pin Messages | `pin_message`, `unpin_message` |
| Embed Links | Message embeds in all send tools |
| Read Message History | `get_messages`, `search_messages`, analysis tools |
| Mention Everyone | `@everyone` / `@here` in messages |
| Use External Emojis | External emojis in messages |
| Change Nickname | `set_nickname` (self) |
| Manage Nicknames | `set_nickname` (other members) |
| Manage Roles | Role CRUD, `assign_role`, `remove_role` |
| Manage Webhooks | Webhook CRUD |
| Manage Emojis & Stickers | `create_emoji`, `delete_emoji` |
| Manage Events | Scheduled events CRUD |
| Manage Threads | `archive_thread`, thread management |
| Create Public Threads | `create_thread`, `create_forum_post` |
| Send Messages in Threads | `send_thread_message` |
| Moderate Members | `time_out_user`, `remove_timeout`, `mass_time_out` |
| Privileged: **Server Members** | `server_analysis`, `user_analysis`, `list_members`, `get_member` |
| Privileged: **Message Content** | `channel_analysis`, `user_analysis`, `search_messages` |
| Privileged: **Presence** | `server_analysis` (online count), `get_member` (presence) |

---

## Gateway Intents

v3.0.0 uses 14 gateway intents for full API coverage:

`Guilds`, `GuildMembers`, `GuildMessages`, `MessageContent`, `GuildModeration`, `GuildPresences`, `GuildMessageReactions`, `DirectMessages`, `DirectMessageReactions`, `GuildInvites`, `GuildWebhooks`, `GuildScheduledEvents`, `GuildEmojisAndStickers`, `GuildIntegrations`
