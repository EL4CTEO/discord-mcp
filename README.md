# Discord MCP

Extensive Discord MCP server for Claude. Manage channels, categories, voice channels, and users — with both single and mass parallel operations.

## Setup

### 1. Create a Discord Bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application → Bot
3. Enable these **Privileged Intents**: `Server Members Intent`, `Message Content Intent`, `Presence Intent`
4. Copy the bot token
5. Invite the bot to your server with permissions: `Manage Channels`, `Ban Members`, `Moderate Members`, `View Channels`, `Read Message History`

### 2. Configure Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "discord": {
      "command": "npx",
      "args": ["-y", "github:EL4CTEO/discord-mcp"],
      "env": {
        "DISCORD_BOT_TOKEN": "your-bot-token-here"
      }
    }
  }
}
```

Config file location:
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

Restart Claude Desktop — the Discord tools will appear automatically.

---

## Tools

### Channel Management

| Tool | Description |
|------|-------------|
| `create_channel` | Create a single text channel |
| `create_category` | Create a single category |
| `create_voice_channel` | Create a single voice channel |
| `mass_channels` | Create multiple text channels in parallel |
| `mass_categories` | Create multiple categories in parallel |
| `mass_voice_channels` | Create multiple voice channels in parallel |
| `delete` | Delete a single channel/category by ID |
| `mass_delete` | Delete multiple channels/categories in parallel |

### Analysis

| Tool | Description |
|------|-------------|
| `server_analysis` | Full server overview: members, channels, roles, boosts, features |
| `channel_analysis` | Channel stats: top users, top words, message volume, attachments |
| `user_analysis` | User stats: messages per channel, top words, roles, join date, recent messages |

### Moderation

| Tool | Description |
|------|-------------|
| `ban_user` | Ban a single user |
| `time_out_user` | Timeout a single user (duration in minutes) |
| `mass_ban` | Ban multiple users in parallel |
| `mass_time_out` | Timeout multiple users in parallel |

---

## Example Prompts

```
Analyze the server with ID 123456789012345678

Create channels: general, announcements, off-topic in guild 123456789012345678

Create 5 categories: Gaming, Music, Art, Tech, General in guild 123456789012345678

Analyze what user 987654321098765432 has been saying in guild 123456789012345678

Ban users 111111111, 222222222, 333333333 from guild 123456789012345678 for spamming
```

## Required Bot Permissions

- `MANAGE_CHANNELS` — create/delete channels and categories
- `BAN_MEMBERS` — ban users
- `MODERATE_MEMBERS` — timeout users
- `VIEW_CHANNEL` + `READ_MESSAGE_HISTORY` — required for analysis tools
- Privileged intents: **Server Members**, **Message Content**, **Presence**
