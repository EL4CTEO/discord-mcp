import { Routes } from "discord-api-types/v10";
import type { APIMessage } from "discord-api-types/v10";
import { isSnowflake } from "../discord/resolve.js";
import { ToolError } from "../lib/errors.js";
import { parseEmoji } from "../lib/text.js";
import type { ToolContext } from "./registry.js";

/** Discord returns at most this many messages per history request. */
const PAGE = 100;

/**
 * Resolves a channel reference without forcing a guild lookup.
 *
 * When the caller already has a channel ID (very common in multi-step
 * workflows) this skips the guild listing entirely - one less round trip per
 * call, and it lets DM channels work even though they belong to no guild.
 */
export async function resolveChannel(
  ctx: ToolContext,
  channel: string,
  guild?: string,
  options: { exact?: boolean } = {},
): Promise<string> {
  const trimmed = channel.trim();
  if (isSnowflake(trimmed)) return trimmed;
  const guildId = await ctx.resolver.guildId(guild);
  return ctx.resolver.channelId(trimmed, guildId, options);
}

/**
 * Resolves guild + channel together when the guild ID is needed as well.
 *
 * A channel given by ID already identifies its server, so `guild` is not
 * required even when the bot is in several - it is derived from the channel.
 */
export async function resolveGuildChannel(
  ctx: ToolContext,
  channel: string,
  guild?: string,
  options: { exact?: boolean } = {},
): Promise<{ guildId: string; channelId: string }> {
  const trimmed = channel.trim();
  if (guild === undefined && isSnowflake(trimmed)) {
    const owner = await ctx.resolver.channelGuildId(trimmed);
    if (owner) return { guildId: owner, channelId: trimmed };
  }

  const guildId = await ctx.resolver.guildId(guild);
  const channelId = await ctx.resolver.channelId(trimmed, guildId, options);
  return { guildId, channelId };
}

/** The server a (resolved) channel belongs to, for looking up members or emojis there. */
export async function guildForChannel(ctx: ToolContext, channelId: string, guild?: string): Promise<string> {
  if (guild !== undefined) return ctx.resolver.guildId(guild);
  const owner = await ctx.resolver.channelGuildId(channelId).catch(() => null);
  return owner ?? ctx.resolver.guildId();
}

/** Pluralises a count for summary lines: 3 -> "3 messages", 1 -> "1 message". */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

export interface HistoryQuery {
  limit: number;
  before?: string | undefined;
  after?: string | undefined;
  around?: string | undefined;
  /** Stop paging once this returns true for a fetched page. */
  stop?: (page: readonly APIMessage[]) => boolean;
}

/**
 * Reads message history beyond Discord's 100-per-request cap by paging.
 *
 * Always returns newest first, like the API, whichever direction it paged in.
 * Pages share one rate-limit bucket, so they are fetched sequentially.
 */
export async function fetchHistory(ctx: ToolContext, channelId: string, query: HistoryQuery): Promise<APIMessage[]> {
  const route = Routes.channelMessages(channelId);

  if (query.around !== undefined) {
    return ctx.rest.get<APIMessage[]>(route, { limit: Math.min(query.limit, PAGE), around: query.around });
  }

  const out: APIMessage[] = [];
  let before = query.before;
  let after = query.after;

  while (out.length < query.limit && !ctx.signal.aborted) {
    const limit = Math.min(PAGE, query.limit - out.length);
    const page = await ctx.rest.get<APIMessage[]>(route, { limit, before, after });
    out.push(...page);

    if (page.length < limit || query.stop?.(page)) break;
    // The API answers newest first in both directions.
    if (after !== undefined) after = page[0]?.id;
    else before = page[page.length - 1]?.id;
  }

  // Paging forward yields later pages that are newer than earlier ones.
  if (query.after !== undefined) out.sort((a, b) => compareSnowflakes(b.id, a.id));
  return out;
}

/** Orders snowflakes numerically without BigInt: longer is larger, then lexical. */
export function compareSnowflakes(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * Turns any emoji reference into the form the reactions route expects,
 * looking bare custom-emoji names up in the channel's server.
 */
export async function resolveEmoji(
  ctx: ToolContext,
  emoji: string,
  channelId: string,
  guild?: string,
): Promise<string> {
  const parsed = parseEmoji(emoji);
  if ("route" in parsed) return parsed.route;

  const guildId = await guildForChannel(ctx, channelId, guild);
  const emojis = await ctx.resolver.emojis(guildId);
  const target = parsed.lookup.toLowerCase();
  const match =
    emojis.find((e) => e.name === parsed.lookup) ?? emojis.find((e) => e.name?.toLowerCase() === target);

  if (!match?.id || !match.name) {
    throw new ToolError(`No server emoji named "${parsed.lookup}" was found.`, {
      code: "NOT_FOUND",
      hint:
        "Use a unicode emoji such as '✅', or one of this server's emojis: " +
        (emojis.slice(0, 30).map((e) => e.name).join(", ") || "(none)"),
    });
  }

  return `${match.name}:${match.id}`;
}

/**
 * Resolves the target of a permission overwrite. With type 'auto' a role is
 * tried first - overwrites are overwhelmingly per-role - then a member.
 */
export async function resolveOverwriteTarget(
  ctx: ToolContext,
  target: string,
  type: "role" | "member" | "auto",
  guildId: string,
): Promise<{ id: string; type: 0 | 1 }> {
  if (type === "role") return { id: await ctx.resolver.roleId(target, guildId), type: 0 };
  if (type === "member") return { id: await ctx.resolver.memberId(target, guildId), type: 1 };

  // An ID passes straight through either resolver, so decide by what it is.
  const trimmed = target.trim();
  if (/^<@&\d+>$/.test(trimmed)) return { id: await ctx.resolver.roleId(trimmed, guildId), type: 0 };
  if (/^<@!?\d+>$/.test(trimmed)) return { id: await ctx.resolver.memberId(trimmed, guildId), type: 1 };
  if (isSnowflake(trimmed)) {
    const isRole = trimmed === guildId || (await ctx.resolver.roles(guildId)).some((r) => r.id === trimmed);
    return { id: trimmed, type: isRole ? 0 : 1 };
  }

  try {
    return { id: await ctx.resolver.roleId(target, guildId), type: 0 };
  } catch (roleError) {
    if (!(roleError instanceof ToolError) || roleError.code !== "NOT_FOUND") throw roleError;
    try {
      return { id: await ctx.resolver.memberId(target, guildId), type: 1 };
    } catch {
      throw new ToolError(`"${target}" is neither a role nor a member of this server.`, {
        code: "NOT_FOUND",
        hint: roleError.hint,
      });
    }
  }
}
