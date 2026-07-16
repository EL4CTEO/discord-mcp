# Discord MCP

Compact Discord MCP server for Claude — full Discord control in **14 consolidated tools**.

**v6.0.0** — Complete remaster. The 101 tools of v5 are consolidated into 14 resource-grouped tools with an `action` parameter, cutting the tool-schema context cost by **~72%** (61k → 17k chars) while keeping every useful capability. Batch mode is preserved on all tools.

## Design

Each tool covers one resource and takes an `action`:

```json
{ "tool": "channel", "action": "create", "name": "announcements", "type": "announcement" }
{ "tool": "send_message", "action": "reply", "channel": "general", "message_id": "123", "content": "Done!" }
{ "tool": "role", "action": "assign", "user": "el4cteo", "role": "Moderator" }
```

- `channel`, `user`, and `role` parameters accept **IDs or names** everywhere.
- Set a default server once with `guild` → `set_default`; after that `guild_id` is never needed.
- Errors are actionable: wrong action names list the valid ones, missing permissions say what to check.
- Responses are compact JSON; anything above 25k chars is truncated with a hint to paginate.

## Batch Mode

Every tool accepts an optional `requests` array. Items run in parallel; top-level params act as shared defaults:

```json
{
  "tool": "channel",
  "action": "create",
  "requests": [
    { "name": "general" },
    { "name": "memes", "nsfw": true },
    { "name": "voice-lounge", "type": "voice" }
  ]
}
```

Each result carries `status: "success"` or `status: "failed"` with the error message.

---

## Setup

### 1. Create a Discord Bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application → Bot
3. Enable these **Privileged Intents**: `Server Members`, `Message Content`
4. Copy the bot token
5. Invite the bot (replace `YOUR_CLIENT_ID`):

```
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=8544854581706231&integration_type=0&scope=bot
```

### 2. Install

```bash
npm install -g github:EL4CTEO/discord-mcp
```

### 3. Configure your client

#### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "discord": {
      "command": "npx",
      "args": ["-y", "--prefer-online", "github:EL4CTEO/discord-mcp"],
      "env": { "DISCORD_BOT_TOKEN": "YOUR_TOKEN" }
    }
  }
}
```

#### Claude Code (CLI)

```bash
claude mcp add discord -s user -e DISCORD_BOT_TOKEN=YOUR_TOKEN -- npx -y github:EL4CTEO/discord-mcp
```

---

## First Use

1. `guild` → `list` — find your server's ID
2. `guild` → `set_default` — persists to disk, call once
3. `channel` → `list` — resolve channel names/IDs

---

## Tools (14 total)

| Tool | Actions | Covers |
|------|---------|--------|
| `guild` | set_default, list, info, edit | Server selection and settings |
| `channel` | list, info, create, edit, clone, delete, set_permissions | All channel types incl. forums (tags via `info`/`edit`), categories, permission overwrites |
| `read_messages` | fetch, get, search, pinned, reactions | Reading history, message detail incl. attachments and jump URL, substring search, who-reacted |
| `send_message` | send, reply, edit, poll | Text, rich embeds, replies (with/without ping), polls — works in channels and threads |
| `manage_message` | pin, unpin, delete, bulk_delete, react, unreact | Message moderation and reactions |
| `dm` | send, reply, edit, delete, history | Direct messages; `user` accepts ID or username |
| `thread` | create, list, edit | Threads from channels or messages, forum posts with tags, archive/lock |
| `role` | list, create, edit, delete, assign, remove | Role management by ID or name |
| `member` | list, get, edit, prune | Member profiles, nicknames + role changes in one call, inactivity pruning (dry-run by default) |
| `moderate` | kick, ban, unban, timeout, remove_timeout, list_bans, audit_log | Moderation and audit history |
| `invite` | create, list, delete | Invite links |
| `webhook` | create, list, delete, send | Webhooks incl. sending with name/avatar override |
| `automod` | list, create, edit, delete | Keyword/regex/preset/mention-spam rules with block/alert/timeout responses |
| `bot` | info, set_status | Bot identity, uptime, presence/activity |

### Removed in v6

Analytics tools (`server_analysis`, `channel_analysis`, `user_analysis`, `thread_analysis`, `message_stats`, `role_analysis`, `emoji_usage`, `inactive_members`), scheduled events, emoji/sticker management, `send_typing`, `get_vanity_url` (now in `guild` → `info`), `get_avatar`, `crosspost_message`, and `get_voice_states`. The underlying data is still reachable through `read_messages` and `member` where it matters.

---

## Requirements

- Node.js ≥ 18
- A Discord bot token with the intents above
