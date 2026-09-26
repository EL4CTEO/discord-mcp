#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigError, loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { VERSION } from "./version.js";

/**
 * stdio entry point.
 *
 * stdout carries the JSON-RPC stream, so every diagnostic must go to stderr -
 * a stray console.log here corrupts the protocol and the client silently
 * disconnects.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const server = createServer(config);

  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    // Never hang on exit: an unresponsive socket must not keep the process alive.
    setTimeout(() => process.exit(0), 3_000).unref();
    void server.shutdown().finally(() => process.exit(0));
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // The client closing stdin is how it says goodbye. Without this an open
  // gateway socket would keep an orphaned server running in the background.
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);

  // A stray rejection in a background task (cache warm-up, gateway) must not
  // take down the server and every tool with it.
  process.on("unhandledRejection", (reason) => {
    process.stderr.write(`discord-mcp: unhandled rejection: ${String(reason)}\n`);
  });

  await server.mcp.connect(new StdioServerTransport());
  process.stderr.write(
    `discord-mcp ${VERSION} ready: ${server.advertised.length} tools, ` +
      `destructive actions ${config.allowDestructive ? "ENABLED" : "disabled"}\n`,
  );
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(78); // EX_CONFIG
  }
  process.stderr.write(`discord-mcp failed to start: ${String(error)}\n`);
  process.exit(1);
});
