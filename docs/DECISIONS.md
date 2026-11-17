# Rust port decisions (1.5.0)

Short ADRs for the rewrite from TypeScript (1.2.1) to Rust. The TypeScript
source stays available in git history (tag `v1.2.1`, commit `b4e24bb`).

## ADR-001: One-to-one feature port
Status: accepted (2026-11-17)
Decision: all 38 tools, the same tool names, input schemas, environment
variables, exit codes (78 for config errors) and destructive gating.
Consequences: existing MCP client configs keep working unchanged.

## ADR-002: Stack
Status: accepted (2026-11-17)
Decision: `rmcp` (official Rust MCP SDK) over stdio, `tokio`, `twilight-gateway`
for the WebSocket, `reqwest` for REST, `jsonschema` for argument validation.
Consequences: twilight-http was not used: the tools address raw Discord routes
and raw JSON (as `@discordjs/rest` did), and twilight-http only exposes typed
request builders. The REST client keeps discord.js's behaviour instead: per-bucket
queues, global limit, 2 retries on 5xx and network errors, and the same
error-message flattening.

## ADR-003: The tool catalog is the schema source
Status: accepted (2026-11-17)
Decision: `src/tools/catalog.json` holds each tool's title, description,
annotations and JSON schema, captured from the 1.2.1 server's `tools/list`.
Arguments are validated against the same schema, with defaults applied and
unknown nested keys dropped (zod's behaviour); the few zod refinements a schema
cannot express are checked in Rust.
Consequences: what the client sees and what the server accepts cannot drift.
Validation messages come from the JSON-schema validator, not zod.

## ADR-004: Equivalence bar
Status: accepted (2026-11-17)
Decision: handshake, `tools/list`, success and error text match the TypeScript
server exactly; schema-validation wording may differ.
Consequences: proved by a stdio replay of 60 scripted cases against both
servers (60/60 identical) and by tests ported from the vitest suite.
Known differences: `tools/list` no longer carries the TS SDK's
`execution.taskSupport` field; a tool hidden while destructive actions are off
answers a direct call with the destructive-actions refusal rather than the TS
SDK's "tool not found".

## ADR-005: Distribution
Status: accepted (2026-11-17)
Decision: `npx -y @el4cteo/discord-mcp` keeps working: the main npm package is
a small launcher, and one `@el4cteo/discord-mcp-<platform>-<arch>` optional
dependency per platform carries the binary (win32-x64, linux-x64, linux-arm64,
darwin-x64, darwin-arm64). Binaries are also attached to GitHub releases, and
the crate is published as `el4cteo-discord-mcp` (`discord-mcp` is taken).
Consequences: running the server no longer needs Node; installing through npx
still does.
