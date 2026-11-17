<p align="center">
  <img src="assets/logo.svg" width="120" alt="Discord MCP logo">
</p>

<h1 align="center">Discord MCP</h1>

<p align="center">
  Control a Discord bot from Claude Code or any MCP client: messages, channels, roles, members, moderation and live events.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@el4cteo/discord-mcp"><img src="https://img.shields.io/npm/v/@el4cteo/discord-mcp?color=5865F2" alt="npm version"></a>
  <img src="https://img.shields.io/badge/Rust-native-DEA584" alt="Rust">
  <img src="https://img.shields.io/badge/platforms-win%20%7C%20linux%20%7C%20macOS-5865F2" alt="Windows, Linux, macOS">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT license">
</p>

## Features

- **38 tools**: messages, DMs, uploads, forwards, polls, channels, threads, forums, members, roles, moderation, AutoMod, scheduled events, emojis, invites and live events
- **Names instead of IDs**: say `"general"` or `"@everyone"`, never a snowflake
- **Bulk on every tool**: pass an array anywhere a single value goes. `discord_batch` mixes different tools
- **Long messages just work**: text over 2000 characters is split cleanly, and code blocks stay intact
- **Safe by default**: destructive actions stay off until you enable them
- **Hardened against prompt injection**: no admin-grade grants, mass pings, secret-file uploads or internal-network fetches unless you allow them
- **Helpful errors**: every error says *how to fix it*, not just what broke
- **Native and light**: a single Rust binary - instant start, small memory footprint, no Node runtime needed to run it

## Setup

1. Create a bot at [discord.com/developers/applications](https://discord.com/developers/applications) -> **New Application** -> **Bot** -> **Reset Token**.
2. On the same Bot page enable **Message Content Intent** and **Server Members Intent**.
3. Invite it to your server via **OAuth2 -> URL Generator** (scopes: `bot`, `applications.commands`).

## Add to Claude Code

```bash
claude mcp add discord --env DISCORD_TOKEN=your_token_here -- npx -y @el4cteo/discord-mcp
```

`npx` downloads the prebuilt binary for your platform (Windows x64, Linux x64/arm64, macOS x64/arm64).

Or run the binary directly - from the [releases page](https://github.com/EL4CTEO/discord-mcp/releases), `cargo install --git https://github.com/EL4CTEO/discord-mcp`, or a local build:

```bash
git clone https://github.com/EL4CTEO/discord-mcp.git
cd discord-mcp && cargo build --release
claude mcp add discord --env DISCORD_TOKEN=your_token_here -- /absolute/path/to/discord-mcp/target/release/discord-mcp
```

Restart Claude Code, then ask it to run `discord_whoami` to check the connection.

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

\* needs `DISCORD_ALLOW_DESTRUCTIVE=true`, and stays hidden until then. Tools that mix safe and destructive actions (deleting a role, kicking or banning, deleting events, rules, emojis or invites) refuse just the destructive ones.

## Security

Discord messages are written by strangers, and the agent reads them. So the server refuses what an injected instruction would ask for, unless you allow it:

- **Admin-grade grants**: creating or assigning a role with Administrator, Manage Roles, Ban Members and similar, granting them on a channel, or un-hiding a private channel
- **Mass pings**: `@everyone` / `@here` need `DISCORD_ALLOW_MASS_MENTIONS=true`
- **File uploads**: only from `DISCORD_UPLOAD_DIRS`. Keys, `.env` files, the bot token and private keys are refused, even renamed
- **URL uploads**: only public `http(s)` hosts. Private, loopback and cloud-metadata addresses are blocked, including through redirects and DNS tricks
- **Exact targets**: bans, kicks, timeouts, purges and deletes need the exact name or ID, never a partial match
- **Strict arguments**: a misspelled argument is rejected instead of silently ignored

## Batch example

```json
{
  "operations": [
    { "tool": "discord_send_message", "args": { "channel": "general", "content": "Deploy done" } },
    { "tool": "discord_manage_member_roles", "args": { "member": "alice", "add": ["Release"] } }
  ],
  "defaults": { "guild": "my server" }
}
```

One failure does not stop the rest - every operation reports its own result.

## Architecture

```
src/
├─ main.rs           stdio entry point
├─ config.rs         env parsing and validation
├─ server.rs         MCP wiring (rmcp)
├─ rest.rs           Discord REST client, per-bucket rate limiting
├─ gateway.rs        WebSocket (twilight-gateway) - connects lazily, closes when idle
├─ cache.rs          TTL cache for name lookups
├─ resolve.rs        names -> IDs
├─ tools/            one module per capability group, plus catalog.json (the tool schemas)
└─ format.rs, render.rs, text.rs, upload.rs, limiter.rs, permissions.rs
```

REST handles every action, so startup is instant. The WebSocket only opens when a tool needs live events, and closes again after 2 minutes idle.

## Bulk operations

Every tool that acts on a thing accepts an **array** wherever it accepts one value:

```jsonc
// one channel
{ "channel": "general", "content": "hi" }

// or fifty, in parallel, from the same tool
{ "channel": ["general", "announcements", "codes"], "content": "hi" }
```

Items are grouped by rate-limit bucket, run in parallel across buckets, and each reports its own result - so one failure never hides the rest:

```
discord_send_message on 3 items: 2 succeeded, 1 failed.
```

Use `discord_batch` instead when the calls are *different* tools.

## Performance

- **Warm start**: name caches load while the client connects
- **Caches stay fresh**: the server's own edits, and live gateway events, update the caches in place, so nothing needs a refetch
- **Real bulk endpoints**: arrays of message deletes and bans each go out as one request
- **One request for many role changes**: adding or removing several roles on a member is a single call
- **Compact output**: JSON has no indentation, and oversized results are trimmed evenly across items instead of cut off at the end
- **Bucket-aware batching**: calls run in parallel across Discord rate-limit buckets
- **Cancellable**: when the client cancels a call, waits and batches stop, and long batches report their progress

## Development

```bash
cargo run          # needs DISCORD_TOKEN in the environment
cargo test         # unit, tool and stdio tests (no Discord account needed)
cargo clippy --all-targets -- -D warnings
```

Releases: bump the version in `Cargo.toml` and `package.json` (including `optionalDependencies`), then push a `vX.Y.Z` tag. CI builds every platform, attaches the binaries to the GitHub release and publishes to npm.

## Notes

- Reading other people's message content needs the **Message Content Intent**.
- Listing all members needs the **Server Members Intent**.
- To assign or moderate a role, the bot's own role must sit **above** it in Server Settings → Roles.
- Bulk delete only works on messages newer than 14 days.

## License

MIT
