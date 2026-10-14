import { delimiter } from "node:path";
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
    .string({ error: "DISCORD_TOKEN is missing or empty" })
    .trim()
    .min(1, "DISCORD_TOKEN is empty")
    .refine((t) => !t.toLowerCase().startsWith("bot "), {
      message: "DISCORD_TOKEN must not include the 'Bot ' prefix - paste only the raw token",
    }),
  DISCORD_DEFAULT_GUILD: z.string().trim().min(1).optional(),
  DISCORD_ALLOW_DESTRUCTIVE: boolean(false),
  DISCORD_ALLOW_MASS_MENTIONS: boolean(false),
  DISCORD_PRIVILEGED_INTENTS: boolean(true),
  DISCORD_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(15_000),
  DISCORD_MAX_RESPONSE_CHARS: z.coerce.number().int().min(2_000).max(200_000).default(25_000),
  DISCORD_GATEWAY_IDLE_MS: z.coerce.number().int().min(10_000).max(3_600_000).default(120_000),
  DISCORD_EVENT_BUFFER: z.coerce.number().int().min(20).max(5_000).default(200),
  DISCORD_BATCH_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(4),
  DISCORD_UPLOAD_DIRS: z.string().trim().optional(),
});

export interface Config {
  readonly token: string;
  readonly defaultGuild: string | undefined;
  readonly allowDestructive: boolean;
  /** Lets messages ping @everyone/@here (allow_mentions: 'everyone'). */
  readonly allowMassMentions: boolean;
  readonly privilegedIntents: boolean;
  readonly requestTimeoutMs: number;
  readonly maxResponseChars: number;
  readonly gatewayIdleMs: number;
  readonly eventBufferSize: number;
  readonly batchConcurrency: number;
  /** Folders local file uploads may come from; undefined allows any path. */
  readonly uploadDirs: readonly string[] | undefined;
}

/** Thrown when the environment is missing or malformed; the message is user-facing. */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(withoutBlanks(env));

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
    allowMassMentions: e.DISCORD_ALLOW_MASS_MENTIONS,
    privilegedIntents: e.DISCORD_PRIVILEGED_INTENTS,
    requestTimeoutMs: e.DISCORD_REQUEST_TIMEOUT_MS,
    maxResponseChars: e.DISCORD_MAX_RESPONSE_CHARS,
    gatewayIdleMs: e.DISCORD_GATEWAY_IDLE_MS,
    eventBufferSize: e.DISCORD_EVENT_BUFFER,
    batchConcurrency: e.DISCORD_BATCH_CONCURRENCY,
    uploadDirs: parseUploadDirs(e.DISCORD_UPLOAD_DIRS),
  };
}

/**
 * Treats blank variables as unset. MCP client templates often emit `KEY=""` for
 * options the user left empty; those mean "use the default", not a failed start.
 */
function withoutBlanks(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(env).map(([key, value]) => [key, value?.trim() === "" ? undefined : value]));
}

/**
 * Local uploads default to the working directory: where an agent writes the
 * reports and screenshots it means to share. Not the OS temp folder, which
 * also holds other tools' output, and nowhere near home-directory secrets.
 * "*" lifts the restriction entirely.
 */
function parseUploadDirs(raw: string | undefined): readonly string[] | undefined {
  if (raw === "*") return undefined;
  const dirs = (raw ?? "").split(delimiter).map((d) => d.trim()).filter(Boolean);
  return dirs.length > 0 ? dirs : [process.cwd()];
}
