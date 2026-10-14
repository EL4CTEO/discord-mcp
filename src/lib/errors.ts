import { DiscordAPIError, HTTPError, RateLimitError } from "@discordjs/rest";

/**
 * An error that is safe and useful to hand back to an LLM.
 *
 * The `hint` is the important part: it tells the agent what to do next rather
 * than only what went wrong. A raw Discord error like `{"code": 50013}` is
 * useless to a model; "the bot's highest role must be above the target role"
 * is immediately actionable.
 */
export class ToolError extends Error {
  override readonly name = "ToolError";
  readonly hint: string | undefined;
  readonly code: string | number | undefined;

  constructor(
    message: string,
    options: { hint?: string; code?: string | number; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.hint = options.hint;
    this.code = options.code;
  }

  /** Multi-line rendering used as the tool text response on failure. */
  toText(): string {
    return this.hint ? `${this.message}\nHint: ${this.hint}` : this.message;
  }
}

/** Raised by destructive tools when DISCORD_ALLOW_DESTRUCTIVE is not enabled. */
export function destructiveDisabled(action: string): ToolError {
  return new ToolError(
    `Refused: "${action}" is a destructive action and destructive actions are disabled.`,
    {
      code: "DESTRUCTIVE_DISABLED",
      hint:
        "Set DISCORD_ALLOW_DESTRUCTIVE=true in the MCP server environment and restart it. " +
        "It is off by default so an accidental call cannot ban members or delete channels.",
    },
  );
}

/**
 * Discord JSON error codes mapped to what the agent should actually do next.
 * Only codes an agent can plausibly recover from are listed; anything else
 * falls through to the generic HTTP-status advice below.
 */
const CODE_HINTS: Readonly<Record<number, string>> = {
  10003: "That channel does not exist, or the bot is not in its server. Call discord_list_channels for valid channels.",
  10004: "The bot is not a member of that server. Call discord_list_guilds to see which servers it can reach.",
  10007: "That member is not in the server. Use discord_list_members with a search query to find the right person.",
  10008: "That message no longer exists, or it lives in a different channel than the one supplied.",
  10011: "That role does not exist. Call discord_list_roles for valid roles.",
  10013: "No Discord user has that ID.",
  10014: "Unknown emoji. Custom emojis must come from a server the bot is in; pass them as 'name:id' or '<:name:id>'.",
  10026: "That user is not banned, so there is nothing to unban.",
  20001: "This endpoint is for user accounts only and can never be used by a bot.",
  20022: "This announcement channel hit its edit rate limit. Wait a few minutes.",
  20028: "The channel slowmode limit was hit. Send more slowly, or lower the slowmode.",
  30003: "This channel already has the maximum of 50 pinned messages. Unpin one first.",
  30005: "The server already has the maximum of 250 roles.",
  30013: "The server already has the maximum of 500 channels.",
  30016: "The server has hit its invite limit.",
  30007: "The server already has the maximum number of webhooks for this channel.",
  30010: "This message already has the maximum of 20 different reaction emojis.",
  40005: "The upload is too large. Bots may send up to 10 MB per message unless the server is boosted.",
  40007: "That user is already banned from this server.",
  50001: "The bot cannot see that resource. Invite it to the server, or grant its role View Channel on that channel.",
  50005: "A bot can only edit its own messages. Post a new message instead.",
  50006: "Discord rejected an empty message. Supply content, at least one embed, or a file.",
  50007: "That user has DMs from server members turned off, or has blocked the bot.",
  50013: "The bot is missing a permission. Check its role has the needed permission and, for role/kick/ban actions, that the bot highest role sits ABOVE the target user highest role in Server Settings -> Roles.",
  50019: "System messages (pins, joins, boosts) cannot be modified.",
  50021: "Actions cannot be performed on a system message.",
  50024: "That action is not valid for this channel type (for example reading history from a category or voice channel).",
  50034: "Bulk delete only works on messages newer than 14 days. Remove older ones individually with discord_delete_message.",
  50035: "Discord rejected the request body. Check lengths: content <= 2000 chars, embed title <= 256, embed description <= 4096, and that every ID is valid.",
  50036: "The bot is not in the server that invite belongs to.",
  50045: "The uploaded asset is too large.",
  50055: "That server is unavailable right now.",
  50068: "That message type cannot be deleted.",
  50083: "The thread is archived. Unarchive it first via discord_manage_thread with action unarchive.",
  50085: "The requested message range is too large. Lower the limit.",
  50095: "That server is under a raid-protection lockdown.",
  160002: "That message already has an active thread.",
  160004: "A thread cannot be created on this message.",
  160005: "The thread is locked. Unlock it via discord_manage_thread with action unlock.",
  500000: "Bulk ban failed for every user. Check they are not already banned and sit below the bot's highest role.",
};

const STATUS_HINTS: Readonly<Record<number, string>> = {
  400: "Discord rejected the request shape. Re-check argument types and length limits.",
  401: "The bot token is invalid or was reset. Generate a new one (Developer Portal -> Bot -> Reset Token) and update DISCORD_TOKEN.",
  403: "The bot is forbidden from doing this - usually a missing permission or a role-hierarchy problem.",
  404: "That resource does not exist. Double-check the ID, or re-resolve it by name.",
  429: "Rate limited by Discord. Lower concurrency on batch calls, or wait and retry.",
  500: "Discord had an internal error. Retry in a moment.",
  502: "Discord gateway trouble on their side. Retry in a moment.",
  503: "Discord is temporarily unavailable. Retry in a moment.",
  504: "Discord timed out. Retry in a moment.",
};

/**
 * Converts anything thrown inside a tool into a ToolError carrying an
 * agent-actionable hint. `context` names the attempted operation, for example
 * "send message to #general".
 */
export function normalizeError(error: unknown, context: string): ToolError {
  if (error instanceof ToolError) return error;

  if (error instanceof DiscordAPIError) {
    const code = typeof error.code === "number" ? error.code : undefined;
    const hint = (code === undefined ? undefined : CODE_HINTS[code]) ?? STATUS_HINTS[error.status];
    return new ToolError(`Could not ${context}: ${error.message} (Discord code ${error.code})`, {
      code: error.code,
      hint,
      cause: error,
    });
  }

  if (error instanceof RateLimitError) {
    const seconds = Math.ceil(error.timeToReset / 1000);
    return new ToolError(`Could not ${context}: rate limited for ${seconds}s on route ${error.route}.`, {
      code: 429,
      hint: "Retry after the wait, and reduce concurrency if this came from a batch call.",
      cause: error,
    });
  }

  if (error instanceof HTTPError) {
    return new ToolError(`Could not ${context}: HTTP ${error.status} ${error.message}`, {
      code: error.status,
      hint: STATUS_HINTS[error.status],
      cause: error,
    });
  }

  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") {
      // @discordjs/rest reports its own timeout as an abort too, so the two
      // cannot be told apart here; the message covers both.
      return new ToolError(`Could not ${context}: the request was cancelled or timed out.`, {
        code: "TIMEOUT",
        hint: "If it was not cancelled, Discord may be slow: retry, or raise DISCORD_REQUEST_TIMEOUT_MS.",
        cause: error,
      });
    }
    return new ToolError(`Could not ${context}: ${error.message}`, { cause: error });
  }

  return new ToolError(`Could not ${context}: ${String(error)}`);
}
