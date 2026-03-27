# Discord MCP

Extensive Discord MCP server for Claude — optimized for autonomous task workflows. Manage channels, messages, roles, threads, members, and more with both single and mass parallel operations.

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
https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=274945035094&scope=bot
```

**Required permissions:** `Kick Members`, `Ban Members`, `Manage Channels`, `View Channel`, `Send Messages`, `Manage Messages`, `Add Reactions`, `Read Message History`, `Manage Roles`, `Moderate Members (Timeout)`

### 2. Install globally

```bash
npm install -g github:EL4CTEO/discord-mcp
```

### 3. Configure Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "discord": {
    "command": "npx",
    "args": ["-y", "--prefer-online", "github:EL4CTEO/discord-mcp"],
    "env": {
      "DISCORD_BOT_TOKEN": "YOUR_TOKEN"
    }
  }
}
```

Config locations:
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

> **Tip:** Using `npx -y github:EL4CTEO/discord-mcp` also works but downloads every time, which can cause startup timeouts. Global install is recommended.

---

## First Use

1. **List servers the bot is in:** `list_guilds`
2. **Set your default server** (persists to disk — only needed once): `set_guild 123456789012345678`
3. **List all channels with IDs:** `list_channels`

After `set_guild`, you never need to specify `guild_id` again.

---

## Tools

### Guild

| Tool | Description |
|------|-------------|
| `set_guild` | Persist a default guild ID to disk. Call once — survives restarts. |
| `get_guild` | Get the currently persisted default guild ID. |
| `list_guilds` | List all servers the bot is in. |

### Channels

| Tool | Description |
|------|-------------|
| `list_channels` | List all channels with IDs, names, types, and categories. Accepts channel name to resolve to ID. |
| `create_channel` | Create a single text channel. |
| `create_category` | Create a single category. |
| `create_voice_channel` | Create a single voice channel. |
| `rename_channel` | Rename an existing channel or category. |
| `set_channel_topic` | Set or update a text channel's topic. |
| `move_channel` | Move a channel into a different category. |
| `mass_channels` | Create multiple text channels in parallel. |
| `mass_categories` | Create multiple categories in parallel. |
| `mass_voice_channels` | Create multiple voice channels in parallel. |
| `delete` | Delete a single channel or category by ID. |
| `mass_delete` | Delete multiple channels/categories in parallel. |

### Messages

| Tool | Description |
|------|-------------|
| `send_message` | Send a message (+ optional embed) to a channel. Accepts channel name or ID. |
| `get_messages` | Fetch recent messages (default 20, max 100). Supports `before_message_id` and `after_message_id` pagination. |
| `get_message` | Fetch a single message by ID. |
| `search_messages` | Search for messages containing a keyword in a channel. |
| `reply_message` | Reply to a specific message, pinging the author. Supports embeds. |
| `edit_message` | Edit a bot message. Supports embeds. |
| `pin_message` | Pin a message in a channel. |
| `unpin_message` | Unpin a message from a channel. |
| `delete_message` | Delete a specific message. |
| `bulk_delete_messages` | Delete up to 100 messages at once using Discord's native API (messages must be <14 days old). |
| `mass_send_message` | Send messages (+ optional embeds) to multiple channels in parallel. |
| `mass_delete_message` | Delete multiple messages in parallel (use `bulk_delete_messages` for newer messages). |
| `add_reaction` | Add an emoji reaction to a message. |
| `send_dm` | Send a DM to a user by snowflake ID. Supports embeds. |
| `send_dm_by_username` | Send a DM to a user by username or display name. |

### Roles

| Tool | Description |
|------|-------------|
| `list_roles` | List all roles with IDs, names, colors, positions, and member counts. |
| `create_role` | Create a single role (with optional color, hoist, mentionable). |
| `delete_role` | Delete a role by ID. |
| `mass_create_role` | Create multiple roles in parallel. |
| `mass_delete_role` | Delete multiple roles in parallel. |
| `assign_role` | Assign a role to a user. Accepts username or snowflake ID. |
| `remove_role` | Remove a role from a user. Accepts username or snowflake ID. |

### Members

| Tool | Description |
|------|-------------|
| `list_members` | List guild members with IDs, usernames, display names, and roles. Supports role filter and limit. |

### Threads

| Tool | Description |
|------|-------------|
| `create_thread` | Create a thread in a channel, optionally attached to a message. |
| `send_thread_message` | Send a message inside a thread. |
| `list_threads` | List active (and optionally archived) threads. |
| `thread_analysis` | Analyze all messages in a thread: participants, word frequency, full history. |
| `archive_thread` | Archive or unarchive (and optionally lock) a thread. |
| `create_forum_post` | Create a new post in a Forum channel (supports embeds). |

### Analysis

| Tool | Description |
|------|-------------|
| `server_analysis` | Full server overview: members, channels, roles, boosts, features. |
| `channel_analysis` | Channel stats: top users, top words, message volume, attachments. |
| `user_analysis` | User stats: messages per channel, top words, roles, join date, recent messages. |

### Moderation

| Tool | Description |
|------|-------------|
| `kick_user` | Kick a user. Accepts username or snowflake ID. |
| `ban_user` | Ban a user. Accepts username or snowflake ID. |
| `unban_user` | Unban a user by snowflake ID. |
| `time_out_user` | Timeout a user for N minutes. |
| `mass_ban` | Ban multiple users in parallel. |
| `mass_time_out` | Timeout multiple users in parallel. |

---

## Embed Support

`send_message`, `reply_message`, `edit_message`, `mass_send_message`, `send_dm`, `send_dm_by_username`, and `create_forum_post` all support an optional `embed` object:

```json
{
  "channel_id": "...",
  "content": "Optional text above the embed",
  "embed": {
    "title": "My Title",
    "description": "My description",
    "color": "#5865F2",
    "fields": [
      { "name": "Field 1", "value": "Value 1", "inline": true },
      { "name": "Field 2", "value": "Value 2", "inline": true }
    ],
    "footer": "Footer text",
    "timestamp": true
  }
}
```

---

## Efficiency Tips

- **`set_guild` once** — it persists to disk, no need to repeat it
- **Use `list_channels`** to find a channel ID by name, not `server_analysis`
- **Use `list_roles`** to find a role ID by name, not `server_analysis`
- **Channel name resolution** — most tools accept channel name or ID directly
- **Use `mass_*` tools** when operating on multiple targets — they run in parallel
- **Use `bulk_delete_messages`** for fast deletion of recent messages (up to 100 at once)
- **If you have a channel ID**, call `send_message` directly with no other calls first

---

## Required Bot Permissions

| Permission | Used by |
|-----------|---------|
| `View Channel` | all read operations |
| `Send Messages` | send_message, reply_message, mass_send_message |
| `Add Reactions` | add_reaction |
| `Read Message History` | get_messages, get_message, search_messages, channel_analysis, thread_analysis |
| `Manage Messages` | delete_message, bulk_delete_messages, mass_delete_message, pin_message, unpin_message |
| `Manage Channels` | create/delete/rename/move channels and categories |
| `Manage Roles` | create_role, delete_role, assign_role, remove_role |
| `Kick Members` | kick_user |
| `Ban Members` | ban_user, unban_user, mass_ban |
| `Moderate Members` | time_out_user, mass_time_out |
| Privileged: **Server Members** | server_analysis, user_analysis, list_members |
| Privileged: **Message Content** | channel_analysis, user_analysis, search_messages |
| Privileged: **Presence** | server_analysis (online count) |

**Permission integer:** `274945035094`
