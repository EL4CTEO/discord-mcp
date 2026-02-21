# Discord MCP

Extensive Discord MCP server for Claude. Manage channels, messages, roles, threads, and users — with both single and mass parallel operations.

## Setup

### 1. Create a Discord Bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application → Bot
3. Enable these **Privileged Intents**: `Server Members Intent`, `Message Content Intent`, `Presence Intent`
4. Copy the bot token
5. Invite the bot (replace `YOUR_CLIENT_ID`):

```
https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=1380786198&scope=bot
```

**Required permissions:** `Manage Channels`, `Ban Members`, `Moderate Members`, `View Channels`, `Read Message History`, `Send Messages`, `Manage Roles`, `Kick Members`

### 2. Install globally

```bash
npm install -g github:EL4CTEO/discord-mcp
```

### 3. Configure Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "discord": {
      "command": "discord-mcp",
      "args": [],
      "env": {
        "DISCORD_BOT_TOKEN": "your-bot-token-here"
      }
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
| `list_channels` | List all channels with IDs, names, types, and categories. Use to resolve a channel name to an ID. |
| `create_channel` | Create a single text channel. |
| `create_category` | Create a single category. |
| `create_voice_channel` | Create a single voice channel. |
| `mass_channels` | Create multiple text channels in parallel. |
| `mass_categories` | Create multiple categories in parallel. |
| `mass_voice_channels` | Create multiple voice channels in parallel. |
| `delete` | Delete a single channel or category by ID. |
| `mass_delete` | Delete multiple channels/categories in parallel. |

### Messages

| Tool | Description |
|------|-------------|
| `send_message` | Send a message to a channel. If channel_id is known, call directly — no prerequisite calls needed. |
| `get_messages` | Fetch recent messages from a channel or thread (default 20, max 100). |
| `reply_message` | Reply to a specific message, pinging the author. |
| `edit_message` | Edit a message previously sent by the bot. |
| `delete_message` | Delete a specific message. |
| `mass_send_message` | Send messages to multiple channels in parallel. |
| `mass_delete_message` | Delete multiple messages from a channel in parallel. |
| `add_reaction` | Add an emoji reaction to a message. |

### Roles

| Tool | Description |
|------|-------------|
| `create_role` | Create a single role (with optional color, hoist, mentionable). |
| `delete_role` | Delete a role by ID. |
| `mass_create_role` | Create multiple roles in parallel. |
| `mass_delete_role` | Delete multiple roles in parallel. |
| `assign_role` | Assign a role to a user. Accepts username or snowflake ID. |
| `remove_role` | Remove a role from a user. Accepts username or snowflake ID. |

### Threads

| Tool | Description |
|------|-------------|
| `create_thread` | Create a thread in a channel, optionally attached to a message. |
| `send_thread_message` | Send a message inside a thread. |
| `list_threads` | List active (and optionally archived) threads. |
| `thread_analysis` | Analyze all messages in a thread: participants, word frequency, full history. |
| `archive_thread` | Archive or unarchive (and optionally lock) a thread. |

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

## Efficiency Tips

- **`set_guild` once** — it persists to disk, no need to repeat it
- **Use `list_channels`** to find a channel ID by name, not `server_analysis`
- **Use `mass_*` tools** when operating on multiple targets — they run in parallel
- **If you have a channel ID**, call `send_message` directly with no other calls first

---

## Required Bot Permissions

| Permission | Used by |
|-----------|---------|
| `Manage Channels` | create/delete channels and categories |
| `Send Messages` | send_message, reply_message, mass_send_message |
| `Read Message History` | get_messages, channel_analysis, thread_analysis |
| `Manage Roles` | create_role, delete_role, assign_role, remove_role |
| `Kick Members` | kick_user |
| `Ban Members` | ban_user, unban_user, mass_ban |
| `Moderate Members` | time_out_user, mass_time_out |
| Privileged: **Server Members** | server_analysis, user_analysis |
| Privileged: **Message Content** | channel_analysis, user_analysis |
| Privileged: **Presence** | server_analysis (online count) |

**Permission integer:** `1380786198`
