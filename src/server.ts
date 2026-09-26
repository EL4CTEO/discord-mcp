import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import { DiscordRest } from "./discord/rest.js";
import { Resolver } from "./discord/resolve.js";
import { GatewayBridge } from "./discord/gateway.js";
import { effectiveSchema, ToolRegistry, renderError, renderOutcome } from "./tools/registry.js";
import type { ProgressReporter } from "./tools/registry.js";
import { allTools } from "./tools/index.js";
import { VERSION } from "./version.js";

export interface DiscordMcpServer {
  readonly mcp: McpServer;
  readonly registry: ToolRegistry;
  /** Names of the tools advertised to the client. */
  readonly advertised: readonly string[];
  shutdown(): Promise<void>;
}

/**
 * Builds the MCP server and registers every tool.
 *
 * Handlers are wrapped once, here, so that every tool shares the same result
 * rendering and failure handling: a thrown error becomes an MCP error result
 * with an actionable hint rather than a protocol-level exception, which keeps
 * the model able to recover instead of losing the turn.
 */
export function createServer(config: Config): DiscordMcpServer {
  const rest = new DiscordRest(config);
  const resolver = new Resolver(rest, config);
  const gateway = new GatewayBridge(rest, config);
  const registry = new ToolRegistry({ config, rest, resolver, gateway });

  registry.add(...allTools);

  // While the gateway is open, its channel/role events keep the name caches
  // current - including changes people make in the Discord client.
  gateway.onDispatch((payload) => resolver.applyDispatch(payload));

  const mcp = new McpServer(
    { name: "discord-mcp", version: VERSION },
    {
      instructions:
        "Controls a Discord bot: messaging, DMs, channels, threads, members, roles, moderation and live events.\n\n" +
        "Every argument that names a server, channel, member or role accepts a human name or a Discord ID, so " +
        "there is no need to look up IDs first.\n\n" +
        "To act on many targets, pass an array to the tool's main argument (e.g. channel: ['a','b']) - it runs " +
        "in parallel with per-item results. Use discord_batch to combine different tools in one call.\n\n" +
        (config.allowDestructive
          ? "Destructive tools (ban, kick, timeout, delete, purge) are ENABLED."
          : "Destructive tools (ban, kick, timeout, delete channel/message, purge, delete role) are disabled and " +
            "hidden; the operator enables them with DISCORD_ALLOW_DESTRUCTIVE=true.") +
        " Call discord_whoami to check what the bot can reach and do.",
    },
  );

  // Hiding disabled tools keeps them out of the model's context entirely;
  // the registry still knows them, so a batch naming one gets a clear refusal.
  const advertised = registry.list().filter((tool) => config.allowDestructive || tool.destructive !== true);

  for (const tool of advertised) {
    mcp.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: effectiveSchema(tool),
        annotations: { title: tool.title, ...tool.annotations },
      },
      async (args: unknown, extra) => {
        const token = extra._meta?.progressToken;
        const progress: ProgressReporter | undefined =
          token === undefined
            ? undefined
            : (done, total, message) => {
                void extra
                  .sendNotification({
                    method: "notifications/progress",
                    params: { progressToken: token, progress: done, total, ...(message ? { message } : {}) },
                  })
                  .catch(() => undefined);
              };

        try {
          const outcome = await registry.run(tool.name, args, { signal: extra.signal, progress });
          return renderOutcome(outcome, config.maxResponseChars);
        } catch (error) {
          return renderError(error, tool.title.toLowerCase());
        }
      },
    );
  }

  // Warm the name-resolution caches while the client is still handshaking, so
  // the first real tool call does not pay for a guild and channel listing.
  void resolver.warm();

  return {
    mcp,
    registry,
    advertised: advertised.map((tool) => tool.name),
    async shutdown() {
      await gateway.disconnect();
      await mcp.close().catch(() => undefined);
    },
  };
}
