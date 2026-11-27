<p align="center">
  <img src="https://raw.githubusercontent.com/EL4CTEO/discord-mcp/main/assets/logo.png" width="120" alt="Discord MCP logo">
</p>

<h1 align="center">Discord MCP</h1>

<p align="center">
  Control a Discord bot from Claude Code or any MCP client: messages, channels, roles, members, moderation and live events.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@el4cteo/discord-mcp"><img src="https://img.shields.io/npm/v/@el4cteo/discord-mcp?color=5865F2" alt="npm version"></a>
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT license">
</p>

## Features

- **38 tools**: messages, DMs, uploads, polls, channels, threads, forums, members, roles, moderation, AutoMod, events, emojis, invites, live events
- **Names, not IDs**: `"general"`, `"@everyone"`, never a snowflake
- **Bulk everywhere**: pass an array wherever one value goes; `discord_batch` mixes tools
- **Long messages split cleanly**, code blocks intact
- **Safe by default**: destructive actions off until enabled; hardened against prompt injection
- **Errors say how to fix them**
- **Single Rust binary**: instant start, small memory, no Node runtime needed

## Setup

1. Create a bot at [discord.com/developers/applications](https://discord.com/developers/applications) -> **New Application** -> **Bot** -> **Reset Token**.
2. On the same Bot page enable **Message Content Intent** and **Server Members Intent**.
3. Invite it to your server via **OAuth2 -> URL Generator** (scopes: `bot`, `applications.commands`).

## Add to Claude Code

```bash
claude mcp add discord --env DISCORD_TOKEN=your_token_here -- npx -y @el4cteo/discord-mcp
```

`npx` downloads the prebuilt binary for your platform (Windows x64, Linux x64/arm64, macOS x64/arm64).

Or use a binary from [Releases](https://github.com/EL4CTEO/discord-mcp/releases) / `cargo install --git https://github.com/EL4CTEO/discord-mcp`, and point `claude mcp add` at it.

Restart Claude Code and ask it to run `discord_whoami`.

## Configuration

| Variable | Default | What it does |
|---|---|---|
| `DISCORD_TOKEN` | *required* | Bot token (no `Bot ` prefix) |
| `DISCORD_DEFAULT_GUILD` | - | Default server, so tools can omit `guild` |
| `DISCORD_ALLOW_DESTRUCTIVE` | `false` | Enables ban, kick, timeout, deletes, and granting admin-grade permissions |
| `DISCORD_ALLOW_MASS_MENTIONS` | `false` | Lets messages ping `@everyone` / `@here` |
| `DISCORD_UPLOAD_DIRS` | working dir | Folders local files may be uploaded from (`*` = anywhere) |
| `DISCORD_PRIVILEGED_INTENTS` | `true` | Set `false` if you cannot enable intents in the portal |
| `DISCORD_BATCH_CONCURRENCY` | `4` | Parallel operations per batch |
| `DISCORD_REQUEST_TIMEOUT_MS` | `15000` | Timeout per Discord request |
| `DISCORD_MAX_RESPONSE_CHARS` | `25000` | Response size cap |
| `DISCORD_GATEWAY_IDLE_MS` | `120000` | Idle time before the live connection closes |
| `DISCORD_EVENT_BUFFER` | `200` | Live events kept in memory |

## Tools

**Server** - `discord_whoami` `discord_list_guilds` `discord_get_guild` `discord_create_invite`

**Channels** - `discord_list_channels` `discord_create_channel` `discord_edit_channel` `discord_delete_channel`\* `discord_manage_thread` `discord_set_channel_permissions` `discord_reorder_channels`

**Messages** - `discord_send_message` `discord_send_dm` `discord_read_messages` `discord_search_messages` `discord_edit_message` `discord_delete_message`\* `discord_react` `discord_pin_message` `discord_manage_poll`

**People** - `discord_list_members` `discord_get_member` `discord_edit_member` `discord_manage_member_roles` `discord_list_roles` `discord_manage_role` `discord_reorder_roles`

**Moderation** - `discord_moderate_member` `discord_bulk_delete`\* `discord_list_bans` `discord_get_audit_log` `discord_automod`

**Community** - `discord_scheduled_events` `discord_manage_emojis` `discord_manage_invites`

**Live events** - `discord_wait_for_event` `discord_recent_events`

**Batch** - `discord_batch`

\* needs `DISCORD_ALLOW_DESTRUCTIVE=true` (hidden until then). Mixed tools refuse only their destructive actions.

## Security

The agent reads messages written by strangers, so the server refuses what an injected instruction would ask for, unless you allow it:

- **Admin-grade grants** (Administrator, Manage Roles, Ban Members…) and un-hiding private channels
- **Mass pings**: `@everyone` / `@here` need `DISCORD_ALLOW_MASS_MENTIONS=true`
- **Uploads**: only from `DISCORD_UPLOAD_DIRS`; keys, `.env`, the bot token and private keys are refused even renamed. URL uploads block private, loopback and metadata addresses (redirects and DNS tricks included)
- **Exact targets** for bans, kicks, timeouts, purges and deletes
- **Strict arguments**: misspelled arguments are rejected

## Bulk and batch

Any tool accepts an array wherever it accepts one value; items run in parallel across rate-limit buckets and each reports its own result:

```jsonc
{ "channel": ["general", "announcements", "codes"], "content": "hi" }
// discord_send_message on 3 items: 2 succeeded, 1 failed.
```

Different tools in one call:

```json
{
  "operations": [
    { "tool": "discord_send_message", "args": { "channel": "general", "content": "Deploy done" } },
    { "tool": "discord_manage_member_roles", "args": { "member": "alice", "add": ["Release"] } }
  ],
  "defaults": { "guild": "my server" }
}
```

REST handles every action; the gateway WebSocket opens only for live events and closes after 2 minutes idle. Bulk deletes and bans use Discord's real bulk endpoints.

## Development

```bash
cargo run          # needs DISCORD_TOKEN in the environment
cargo test         # unit, tool and stdio tests (no Discord account needed)
cargo clippy --all-targets -- -D warnings
```

Release: bump `Cargo.toml` and `package.json` (incl. `optionalDependencies`), push a `vX.Y.Z` tag; CI builds, attaches binaries and publishes to npm.

## Notes

- Reading other people's message content needs the **Message Content Intent**.
- Listing all members needs the **Server Members Intent**.
- To assign or moderate a role, the bot's own role must sit **above** it in Server Settings → Roles.
- Bulk delete only works on messages newer than 14 days.

## License

MIT
