import { z } from "zod";
import { AuditLogEvent, Routes } from "discord-api-types/v10";
import type { APIAuditLog, APIBan, APIGuildMember, RESTPostAPIGuildBulkBanResult } from "discord-api-types/v10";
import { defineTool, errorText } from "./registry.js";
import type { BulkItem, ToolContext } from "./registry.js";
import { fetchHistory, guildForChannel, plural, resolveChannel } from "./util.js";
import { BULK_DELETE_MAX_AGE_MS, deleteMessages } from "./messages.js";
import { clip, formatMember, formatUser, searchableText } from "../lib/format.js";
import { destructiveDisabled, ToolError } from "../lib/errors.js";
import { mapWithConcurrency } from "../lib/limiter.js";
import { isSnowflake } from "../discord/resolve.js";
import { auditReason, channelRef, detail, guildRef, memberRef, messageId } from "../schemas/common.js";

/** Discord returns at most this many bans per request. */
const BAN_PAGE = 1000;
/** Bounds one ban lookup to 10,000 bans, so a huge ban list cannot run unbounded. */
const BAN_MAX_PAGES = 10;

/**
 * Reads the ban list page by page. Bans come back sorted by user id, so `after`
 * continues exactly where the previous page stopped.
 */
async function fetchBans(ctx: ToolContext, guildId: string, after?: string): Promise<APIBan[]> {
  const all: APIBan[] = [];
  let cursor = after;
  for (let page = 0; page < BAN_MAX_PAGES; page++) {
    const batch = await ctx.rest.get<APIBan[]>(Routes.guildBans(guildId), { limit: BAN_PAGE, after: cursor });
    all.push(...batch);
    const last = batch[batch.length - 1];
    if (batch.length < BAN_PAGE || last === undefined) break;
    cursor = last.user.id;
  }
  return all;
}

/**
 * Kick, ban and timeout remove or silence someone, so they sit behind the
 * destructive switch. Unban and untimeout only reverse those, and always work.
 */
function gateModeration(action: string, allowDestructive: boolean): void {
  const removesOrSilences = action === "kick" || action === "ban" || action === "timeout";
  if (removesOrSilences && !allowDestructive) throw destructiveDisabled(`discord_moderate_member ${action}`);
}

/**
 * Resolves the target of a moderation action.
 *
 * Unbanning needs special care: a banned user is no longer a member, so the
 * member search cannot find them by name. Their name is looked up in the ban
 * list instead.
 */
async function moderationTarget(ctx: ToolContext, input: string, guildId: string, action: string): Promise<string> {
  const trimmed = input.trim();
  const mention = /^<@!?(\d{17,20})>$/.exec(trimmed)?.[1];
  if (mention) return mention;
  if (isSnowflake(trimmed)) return trimmed;
  // Removing or silencing the wrong person cannot be undone by the agent, so a
  // name must match exactly rather than by prefix.
  if (action !== "unban") return ctx.resolver.memberId(trimmed, guildId, { exact: true });

  const name = trimmed.replace(/^@/, "").toLowerCase();
  const bans = await fetchBans(ctx, guildId);
  const matches = bans.filter(
    (b) => b.user.username.toLowerCase() === name || b.user.global_name?.toLowerCase() === name,
  );

  if (matches.length === 1) return (matches[0] as APIBan).user.id;
  throw new ToolError(
    matches.length === 0 ? `No banned user named "${input}" was found.` : `"${input}" matches several banned users.`,
    { code: matches.length === 0 ? "NOT_FOUND" : "AMBIGUOUS", hint: "Call discord_list_bans and pass the user ID." },
  );
}

export const moderateMember = defineTool({
  name: "discord_moderate_member",
  bulkArgs: ["member"],
  missingPermissionHint:
    "Needs Kick Members, Ban Members or Timeout Members depending on the action, AND the bot role must sit " +
    "ABOVE the target member in Server Settings -> Roles. Server owners can never be moderated. " +
    "Banning several members at once also needs Manage Server.",
  title: "Kick, ban, unban or time out a member",
  description:
    "Performs a moderation action on a member.\n\n" +
    "- kick: removes them; they can rejoin with an invite.\n" +
    "- ban: removes and blocks them; `delete_message_days` also purges their recent messages. An array of " +
    "members is banned in one request.\n" +
    "- unban: lifts a ban (accepts the banned user's name).\n" +
    "- timeout: mutes them for `duration_minutes` (max 28 days). untimeout clears it.\n\n" +
    "kick, ban and timeout require DISCORD_ALLOW_DESTRUCTIVE=true; unban and untimeout always work.\n\n" +
    "The bot's highest role must be ABOVE the target's. Always pass `reason` - it goes in the audit log.",
  inputSchema: {
    action: z.enum(["kick", "ban", "unban", "timeout", "untimeout"]),
    member: memberRef,
    guild: guildRef.optional(),
    reason: auditReason,
    duration_minutes: z
      .number()
      .int()
      .min(1)
      .max(40320)
      .optional()
      .describe("Timeout length in minutes, max 40320 (28 days). Required for action='timeout'."),
    delete_message_days: z
      .number()
      .int()
      .min(0)
      .max(7)
      .default(0)
      .describe("For ban: also delete this many days of the user's recent messages (0-7)."),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  async bulkHandler(args, bulkArg, members, ctx) {
    gateModeration(args.action, ctx.config.allowDestructive);
    if (bulkArg !== "member" || args.action !== "ban" || members.length < 2) return undefined;

    const guildId = await ctx.resolver.guildId(args.guild);
    const resolved = await mapWithConcurrency(members, ctx.config.batchConcurrency, (m) =>
      moderationTarget(ctx, m, guildId, "ban"),
    );

    const ids = [...new Set(resolved.flatMap((r) => (r.ok ? [r.value] : [])))];
    let banned = new Set<string>();
    let failed = new Set<string>();

    if (ids.length > 0) {
      const result = await ctx.rest.post<RESTPostAPIGuildBulkBanResult>(
        Routes.guildBulkBan(guildId),
        { user_ids: ids, delete_message_seconds: args.delete_message_days * 86400 },
        args.reason,
      );
      banned = new Set(result.banned_users);
      failed = new Set(result.failed_users);
    }

    return members.map<BulkItem>((member, i) => {
      const r = resolved[i];
      if (!r?.ok) return { value: member, ok: false, error: errorText(r?.error) };
      if (banned.has(r.value)) return { value: member, ok: true, summary: `Banned ${member} (${r.value}).` };
      return {
        value: member,
        ok: false,
        error: failed.has(r.value)
          ? "Discord refused this ban - the user may already be banned, or sit above the bot's role."
          : "Not banned.",
      };
    });
  },
  async handler(args, ctx) {
    gateModeration(args.action, ctx.config.allowDestructive);
    if (args.action === "timeout" && args.duration_minutes === undefined) {
      throw new ToolError("`duration_minutes` is required for a timeout.", {
        code: "MISSING_ARG",
        hint: "For example duration_minutes: 60 mutes the member for an hour.",
      });
    }

    const guildId = await ctx.resolver.guildId(args.guild);
    const userId = await moderationTarget(ctx, args.member, guildId, args.action);

    switch (args.action) {
      case "kick":
        await ctx.rest.delete(Routes.guildMember(guildId, userId), args.reason);
        return { summary: `Kicked ${args.member} (${userId}) from server ${guildId}.` };

      case "ban":
        await ctx.rest.put(
          Routes.guildBan(guildId, userId),
          { delete_message_seconds: args.delete_message_days * 86400 },
          args.reason,
        );
        return { summary: `Banned ${args.member} (${userId}) from server ${guildId}.` };

      case "unban":
        await ctx.rest.delete(Routes.guildBan(guildId, userId), args.reason);
        return { summary: `Unbanned ${args.member} (${userId}).` };

      case "timeout":
      case "untimeout": {
        const until =
          args.action === "timeout"
            ? new Date(Date.now() + (args.duration_minutes as number) * 60_000).toISOString()
            : null;
        const [member, roleNames] = await Promise.all([
          ctx.rest.patch<APIGuildMember>(
            Routes.guildMember(guildId, userId),
            { communication_disabled_until: until },
            args.reason,
          ),
          ctx.resolver.roleNames(guildId),
        ]);
        return {
          summary: until
            ? `Timed out ${args.member} for ${args.duration_minutes} minutes (until ${until}).`
            : `Cleared the timeout on ${args.member}.`,
          data: formatMember(member, roleNames),
        };
      }
    }
  },
});

export const bulkDelete = defineTool({
  name: "discord_bulk_delete",
  bulkArgs: ["channel"],
  missingPermissionHint: "Bulk deleting needs the Manage Messages permission in that channel.",
  title: "Purge messages",
  description:
    "Deletes recent messages from a channel, optionally only those by one member or containing some text.\n\n" +
    "Scans up to `limit` recent messages (max 1000). Messages older than 14 days cannot be bulk-deleted and " +
    "are reported as skipped; pinned messages are kept unless include_pinned is true. Cannot be undone.",
  destructive: true,
  inputSchema: {
    channel: channelRef,
    guild: guildRef.optional(),
    limit: z.number().int().min(1).max(1000).default(50).describe("How many recent messages to consider (1-1000)."),
    before: messageId.optional().describe("Only consider messages older than this message ID."),
    from_author: memberRef.optional().describe("Only delete messages by this member."),
    contains: z.string().min(1).optional().describe("Only delete messages containing this text."),
    include_pinned: z.boolean().default(false).describe("Also delete pinned messages."),
    reason: auditReason,
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  async handler(args, ctx) {
    const channelId = await resolveChannel(ctx, args.channel, args.guild, { exact: true });
    const cutoff = Date.now() - BULK_DELETE_MAX_AGE_MS;

    const [recent, authorId] = await Promise.all([
      fetchHistory(ctx, channelId, {
        limit: args.limit,
        before: args.before,
        // Nothing past 14 days is deletable in bulk, so stop paging there.
        stop: (page) => Date.parse(page[page.length - 1]?.timestamp ?? "") <= cutoff,
      }),
      args.from_author
        ? guildForChannel(ctx, channelId, args.guild).then((g) => ctx.resolver.memberId(args.from_author as string, g, { exact: true }))
        : undefined,
    ]);

    const needle = args.contains?.toLowerCase();
    const candidates = recent.filter(
      (m) =>
        (authorId === undefined || m.author.id === authorId) &&
        (needle === undefined || searchableText(m).toLowerCase().includes(needle)),
    );

    const pinned = args.include_pinned ? 0 : candidates.filter((m) => m.pinned).length;
    const eligible = args.include_pinned ? candidates : candidates.filter((m) => !m.pinned);
    const deletable = eligible.filter((m) => Date.parse(m.timestamp) > cutoff);
    const tooOld = eligible.length - deletable.length;

    const notes = [
      tooOld > 0 ? `${tooOld} older than 14 days skipped` : "",
      pinned > 0 ? `${pinned} pinned kept` : "",
    ].filter(Boolean);
    const tail = notes.length > 0 ? ` (${notes.join(", ")})` : "";

    if (deletable.length === 0) {
      return { summary: `Nothing deleted: ${plural(candidates.length, "message")} matched${tail}.` };
    }

    const failures = await deleteMessages(
      ctx,
      channelId,
      deletable.map((m) => m.id),
      args.reason,
    );
    const deleted = deletable.length - failures.size;

    return {
      summary: `Deleted ${plural(deleted, "message")} from channel ${channelId}${tail}.`,
      data: {
        deleted,
        skipped_too_old: tooOld,
        kept_pinned: pinned,
        failed: failures.size > 0 ? [...failures].map(([id, e]) => ({ id, error: errorText(e) })) : undefined,
      },
    };
  },
});

export const listBans = defineTool({
  name: "discord_list_bans",
  title: "List banned users",
  description: "Lists users banned from a server, with the reason recorded at ban time. Read-only.",
  inputSchema: {
    guild: guildRef.optional(),
    query: z.string().min(1).optional().describe("Only bans whose username or reason contains this text."),
    limit: z.number().int().min(1).max(1000).default(100),
    after: z.string().regex(/^\d{17,20}$/).optional().describe("Page forward from this user id."),
  },
  missingPermissionHint: "Listing bans needs the Ban Members permission.",
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async handler(args, ctx) {
    const guildId = await ctx.resolver.guildId(args.guild);
    // A text search has to see every ban to be useful, so it pages the whole list.
    const bans =
      args.query === undefined
        ? await ctx.rest.get<APIBan[]>(Routes.guildBans(guildId), { limit: args.limit, after: args.after })
        : await fetchBans(ctx, guildId, args.after);

    const needle = args.query?.toLowerCase();
    const shown = (
      needle === undefined
        ? bans
        : bans.filter((b) =>
            [b.user.username, b.user.global_name ?? "", b.reason ?? ""].some((t) => t.toLowerCase().includes(needle)),
          )
    ).slice(0, args.limit);

    const last = bans[bans.length - 1];
    const more =
      needle === undefined && bans.length === args.limit && last ? ` More bans exist: pass after=${last.user.id}.` : "";

    return {
      summary: `${plural(shown.length, "ban")} in server ${guildId}.${more}`,
      data: shown.map((b) => ({ ...formatUser(b.user), reason: b.reason ?? undefined })),
    };
  },
});

/** "MemberBanAdd" -> "member_ban_add", for every action type Discord defines. */
const AUDIT_ACTIONS: ReadonlyMap<number, string> = new Map(
  Object.entries(AuditLogEvent)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number")
    .map(([name, value]) => [value, name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()]),
);
const AUDIT_BY_NAME = new Map([...AUDIT_ACTIONS].map(([value, name]) => [name, value]));
const AUDIT_NAMES = [...AUDIT_BY_NAME.keys()] as [string, ...string[]];

export const getAuditLog = defineTool({
  name: "discord_get_audit_log",
  missingPermissionHint: "Reading the audit log needs the View Audit Log permission.",
  title: "Read the server audit log",
  description:
    "Reads recent moderation and configuration changes from the audit log - 'who deleted that channel?', " +
    "'who banned this user?'. detail='full' includes the old and new values of each change.",
  inputSchema: {
    guild: guildRef.optional(),
    limit: z.number().int().min(1).max(100).default(50),
    action: z.enum(AUDIT_NAMES).optional().describe("Filter to one kind of action, e.g. 'member_ban_add'."),
    by_member: memberRef.optional().describe("Only entries produced by this moderator."),
    before: z.string().regex(/^\d{17,20}$/).optional().describe("Page back: entries older than this entry id."),
    detail,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async handler(args, ctx) {
    const guildId = await ctx.resolver.guildId(args.guild);
    const userId = args.by_member ? await ctx.resolver.memberId(args.by_member, guildId) : undefined;

    const log = await ctx.rest.get<APIAuditLog>(Routes.guildAuditLog(guildId), {
      limit: args.limit,
      action_type: args.action ? AUDIT_BY_NAME.get(args.action) : undefined,
      user_id: userId,
      before: args.before,
    });

    const users = new Map(log.users.map((u) => [u.id, u.username]));
    const show = (value: unknown): unknown =>
      typeof value === "string" ? clip(value, 200) : value === undefined ? undefined : clip(JSON.stringify(value), 200);

    const data = log.audit_log_entries.map((entry) => ({
      id: entry.id,
      action: AUDIT_ACTIONS.get(entry.action_type) ?? `action_${entry.action_type}`,
      by: entry.user_id ? (users.get(entry.user_id) ?? entry.user_id) : undefined,
      target_id: entry.target_id ?? undefined,
      target_user: entry.target_id ? users.get(entry.target_id) : undefined,
      reason: entry.reason ?? undefined,
      changes:
        args.detail === "full"
          ? entry.changes?.map((c) => ({ key: c.key, old: show(c.old_value), new: show(c.new_value) }))
          : entry.changes?.map((c) => c.key),
    }));

    return { summary: `${plural(data.length, "audit log entry", "audit log entries")} for server ${guildId}.`, data };
  },
});
