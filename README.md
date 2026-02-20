# Discord MCP

Extensive Discord MCP server for Claude. Manage channels, categories, voice channels, and users — with both single and mass parallel operations.

## Setup

### 1. Create a Discord Bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application → Bot
3. Enable these **Privileged Intents**: `Server Members Intent`, `Message Content Intent`, `Presence Intent`
4. Copy the bot token
5. Invite the bot using this URL (replace `YOUR_CLIENT_ID`):

```
https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=1380786198&scope=bot
```

**Required permissions:** `Manage Channels`, `Ban Members`, `Moderate Members`, `View Channels`, `Read Message History`

### 2. Install globally (recommended)

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

Config file location:
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

Restart Claude Desktop — the Discord tools will appear automatically.

> **Note:** Using `npx -y github:EL4CTEO/discord-mcp` also works but downloads the package every time, which can cause timeout errors on startup. The global install is faster and more reliable.

---

## First Use

After restarting Claude Desktop, run these commands to get started:

1. **See all servers the bot is in:**
   > "list_guilds"

2. **Set your default server** (so you don't need to specify guild_id every time):
   > "set_guild with ID 123456789012345678"

3. **Verify it's set:**
   > "get_guild"

---

## Tools

### Guild Management

| Tool | Description |
|------|-------------|
| `set_guild` | Set the default server ID (persists between sessions) |
| `get_guild` | Get the currently set default server |
| `list_guilds` | List all servers the bot is in |

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
list_guilds

set_guild 123456789012345678

Analyze the server

Create channels: general, announcements, off-topic

Create 5 categories: Gaming, Music, Art, Tech, General

Analyze what user 987654321098765432 has been saying

Ban users 111111111, 222222222, 333333333 for spamming
```

---

## Required Bot Permissions

| Permission | Used by |
|-----------|---------|
| `Manage Channels` | create/delete channels and categories |
| `Ban Members` | ban_user, mass_ban |
| `Moderate Members` | time_out_user, mass_time_out |
| `View Channel` + `Read Message History` | channel_analysis, user_analysis |
| Privileged intent: **Server Members** | server_analysis, user_analysis |
| Privileged intent: **Message Content** | channel_analysis, user_analysis |
| Privileged intent: **Presence** | server_analysis (online members count) |

**Permission integer:** `1380786198`
