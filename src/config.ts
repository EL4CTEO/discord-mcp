import { z } from "zod";

/** Accepts the usual spellings people type for a boolean env var. */
const boolean = (fallback: boolean) =>
  z
    .enum(["true", "false", "1", "0", "yes", "no"])
    .default(fallback ? "true" : "false")
    .transform((v) => v === "true" || v === "1" || v === "yes");

/**
 * Runtime configuration, parsed once at startup.
 * Everything except the token has a sane default, so the minimum viable
 * configuration is a single DISCORD_TOKEN entry.
 */
const EnvSchema = z.object({
  DISCORD_TOKEN: z
    .string()
    .trim()
    .min(1, "DISCORD_TOKEN is empty")
    .refine((t) => !t.toLowerCase().startsWith("bot "), {
      message: "DISCORD_TOKEN must not include the 'Bot ' prefix - paste only the raw token",
    }),
  DISCORD_DEFAULT_GUILD: z.string().trim().min(1).optional(),
  DISCORD_ALLOW_DESTRUCTIVE: boolean(false),
  DISCORD_PRIVILEGED_INTENTS: boolean(true),
  DISCORD_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(15_000),
  DISCORD_MAX_RESPONSE_CHARS: z.coerce.number().int().min(2_000).max(200_000).default(25_000),
  DISCORD_GATEWAY_IDLE_MS: z.coerce.number().int().min(10_000).max(3_600_000).default(120_000),
  DISCORD_EVENT_BUFFER: z.coerce.number().int().min(20).max(5_000).default(200),
  DISCORD_BATCH_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(4),
});

export interface Config {
  readonly token: string;
  readonly defaultGuild: string | undefined;
  readonly allowDestructive: boolean;
  readonly privilegedIntents: boolean;
  readonly requestTimeoutMs: number;
  readonly maxResponseChars: number;
  readonly gatewayIdleMs: number;
  readonly eventBufferSize: number;
  readonly batchConcurrency: number;
}

/** Thrown when the environment is missing or malformed; the message is user-facing. */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new ConfigError(
      `Invalid Discord MCP configuration:\n${details}\n\n` +
        "Set DISCORD_TOKEN to your bot token. Create one at\n" +
        "https://discord.com/developers/applications -> your app -> Bot -> Reset Token",
    );
  }

  const e = parsed.data;
  return {
    token: e.DISCORD_TOKEN,
    defaultGuild: e.DISCORD_DEFAULT_GUILD,
    allowDestructive: e.DISCORD_ALLOW_DESTRUCTIVE,
    privilegedIntents: e.DISCORD_PRIVILEGED_INTENTS,
    requestTimeoutMs: e.DISCORD_REQUEST_TIMEOUT_MS,
    maxResponseChars: e.DISCORD_MAX_RESPONSE_CHARS,
    gatewayIdleMs: e.DISCORD_GATEWAY_IDLE_MS,
    eventBufferSize: e.DISCORD_EVENT_BUFFER,
    batchConcurrency: e.DISCORD_BATCH_CONCURRENCY,
  };
}
