import { z } from "zod";
import { Routes } from "discord-api-types/v10";
import type { APIGuildMember, APIRole } from "discord-api-types/v10";
import { defineTool, errorText } from "./registry.js";
import { plural } from "./util.js";
import { formatMember } from "../lib/format.js";
import { mapWithConcurrency } from "../lib/limiter.js";
import { assertMayGrant } from "../lib/guards.js";
import { ToolError } from "../lib/errors.js";
import { auditReason, channelRef, guildRef, memberRef, roleRef } from "../schemas/common.js";

export const listMembers = defineTool({
  name: "discord_list_members",
  title: "List or search server members",
  description:
    "Lists members of a server, or searches them by name.\n\n" +
    "`query` searches by username/nickname prefix and always works. Listing without a query needs the " +
    "SERVER MEMBERS intent; without it Discord returns only the bot. Role ids are shown as role names.",
  inputSchema: {
    guild: guildRef.optional(),
    query: z.string().min(1).max(100).optional().describe("Search by username or nickname prefix."),
    limit: z.number().int().min(1).max(1000).default(100),
    after: z.string().regex(/^\d{17,20}$/).optional().describe("Page forward: the next_after value from the previous page."),
    with_role: roleRef.optional().describe("Keep only members who have this role (filters the fetched page)."),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async handler(args, ctx) {
    const guildId = await ctx.resolver.guildId(args.guild);

    const [roleNames, members, roleId] = await Promise.all([
      ctx.resolver.roleNames(guildId),
      args.query
        ? ctx.rest.get<APIGuildMember[]>(Routes.guildMembersSearch(guildId), { query: args.query, limit: args.limit })
        : ctx.rest.get<APIGuildMember[]>(Routes.guildMembers(guildId), { limit: args.limit, after: args.after }),
      args.with_role ? ctx.resolver.roleId(args.with_role, guildId) : undefined,
    ]);

    // @everyone resolves to the guild id, which no member lists in its roles, so it filters nothing.
    const filterId = roleId === guildId ? undefined : roleId;
    const filtered = filterId === undefined ? members : members.filter((m) => m.roles.includes(filterId));
    const last = members[members.length - 1];
    const more =
      !args.query && members.length === args.limit && last ? ` More members exist: pass after=${last.user.id}.` : "";

    return {
      summary:
        `${plural(filtered.length, "member")} in server ${guildId}` +
        (filterId === undefined ? "" : ` with that role (of ${members.length} fetched)`) +
        `.${more}`,
      data: filtered.map((m) => formatMember(m, roleNames)),
    };
  },
});

export const getMember = defineTool({
  name: "discord_get_member",
  bulkArgs: ["member"],
  title: "Get one member's details",
  description:
    "Fetches a member's details: display name, roles, join date, boost status and any active timeout. " +
    "Accepts a username, nickname, @mention or user id.",
  inputSchema: { member: memberRef, guild: guildRef.optional() },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async handler(args, ctx) {
    const guildId = await ctx.resolver.guildId(args.guild);

    const [resolved, roleNames] = await Promise.all([
      ctx.resolver.member(args.member, guildId),
      ctx.resolver.roleNames(guildId),
    ]);
    // A name search already returned the full member; only an ID needs a fetch.
    const member =
      resolved.member ?? (await ctx.rest.get<APIGuildMember>(Routes.guildMember(guildId, resolved.id)));
    const formatted = formatMember(member, roleNames);

    return {
      summary: `${formatted.display_name} (@${formatted.username}) in server ${guildId}.`,
      data: { ...formatted, premium_since: member.premium_since ?? undefined },
    };
  },
});

export const editMember = defineTool({
  name: "discord_edit_member",
  bulkArgs: ["member"],
  title: "Edit a member",
  description:
    "Changes a member's nickname or voice state (mute, deafen, move, disconnect).\n\n" +
    "The bot's highest role must sit above the member's highest role, except when renaming itself.",
  inputSchema: {
    member: memberRef,
    guild: guildRef.optional(),
    nickname: z.string().max(32).nullable().optional().describe("New nickname, or null to clear it."),
    mute: z.boolean().optional().describe("Server-mute in voice channels."),
    deaf: z.boolean().optional().describe("Server-deafen in voice channels."),
    move_to_voice_channel: channelRef.nullable().optional().describe("Move to this voice channel, or null to disconnect."),
    reason: auditReason,
  },
  missingPermissionHint:
    "Needs Manage Nicknames (nickname), Mute/Deafen Members or Move Members (voice), and the bot's highest " +
    "role must sit above the member's.",
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async handler(args, ctx) {
    if (
      args.nickname === undefined &&
      args.mute === undefined &&
      args.deaf === undefined &&
      args.move_to_voice_channel === undefined
    ) {
      throw new ToolError("Nothing to change: pass nickname, mute, deaf or move_to_voice_channel.", {
        code: "MISSING_ARG",
      });
    }

    const guildId = await ctx.resolver.guildId(args.guild);
    const [userId, voiceChannelId, selfId, roleNames] = await Promise.all([
      ctx.resolver.memberId(args.member, guildId),
      args.move_to_voice_channel === undefined || args.move_to_voice_channel === null
        ? args.move_to_voice_channel
        : ctx.resolver.channelId(args.move_to_voice_channel, guildId),
      ctx.resolver.selfId(),
      ctx.resolver.roleNames(guildId),
    ]);

    // A bot renaming itself must use the @me route: the normal member route
    // demands Manage Nicknames plus a role above the target, and nothing can
    // outrank its own highest role. Discord gates self-rename on Change
    // Nickname instead, which is what @me checks.
    const renamingSelf =
      userId === selfId && args.mute === undefined && args.deaf === undefined && voiceChannelId === undefined;

    const member = renamingSelf
      ? await ctx.rest.patch<APIGuildMember>(Routes.guildMember(guildId, "@me"), { nick: args.nickname }, args.reason)
      : await ctx.rest.patch<APIGuildMember>(
          Routes.guildMember(guildId, userId),
          { nick: args.nickname, mute: args.mute, deaf: args.deaf, channel_id: voiceChannelId },
          args.reason,
        );

    return { summary: `Updated member ${userId}.`, data: formatMember(member, roleNames) };
  },
});

export const manageMemberRoles = defineTool({
  name: "discord_manage_member_roles",
  bulkArgs: ["member"],
  missingPermissionHint:
    "Needs Manage Roles, and the bot role must sit ABOVE both the target member and every role assigned.",
  title: "Add or remove roles on a member",
  description:
    "Grants or revokes roles for a member - any number in one call, applied in a single request.\n\n" +
    "The bot's highest role must be ABOVE every role being assigned and above the member's highest role. " +
    "Managed roles (bot roles, Nitro booster) cannot be assigned manually.",
  inputSchema: {
    member: memberRef,
    guild: guildRef.optional(),
    add: z.array(roleRef).max(25).optional().describe("Roles to grant."),
    remove: z.array(roleRef).max(25).optional().describe("Roles to revoke."),
    reason: auditReason,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async handler(args, ctx) {
    if (!args.add?.length && !args.remove?.length) {
      throw new ToolError("Nothing to do: pass at least one role in `add` or `remove`.", {
        code: "MISSING_ARG",
        hint: "Call discord_list_roles to see the roles available in this server.",
      });
    }

    const guildId = await ctx.resolver.guildId(args.guild);
    // Taking a role away is a removal, so its targets must match exactly, like other removals.
    const removing = (args.remove?.length ?? 0) > 0;
    const [resolved, addIds, removeIds] = await Promise.all([
      ctx.resolver.member(args.member, guildId, { exact: removing }),
      Promise.all((args.add ?? []).map((r) => ctx.resolver.roleId(r, guildId))),
      Promise.all((args.remove ?? []).map((r) => ctx.resolver.roleId(r, guildId, { exact: true }))),
    ]);
    const userId = resolved.id;

    const clash = addIds.filter((id) => removeIds.includes(id));
    if (clash.length > 0) {
      throw new ToolError("The same role is in both add and remove.", { code: "CONFLICTING_ARGS" });
    }

    // Granting a role with Administrator or Manage Roles is gated like a
    // destructive action. Removing roles is never gated. Checked before any request.
    if (!ctx.config.allowDestructive && addIds.length > 0) {
      // Read fresh, not from cache: a role given Administrator in the Discord
      // client a minute ago must not pass on its old permissions.
      const byId = new Map((await ctx.rest.get<APIRole[]>(Routes.guildRoles(guildId))).map((r) => [r.id, r]));
      for (const id of addIds) {
        const role = byId.get(id);
        if (role === undefined) {
          throw new ToolError(`Role ${id} does not exist in this server.`, {
            code: "NOT_FOUND",
            hint: "Call discord_list_roles for valid roles.",
          });
        }
        assertMayGrant(role.permissions, false, `member ${args.member} via role "${role.name}"`);
      }
    }

    const operations = [
      ...addIds.map((roleId, i) => ({ roleId, label: `+${args.add?.[i] ?? roleId}`, mode: "add" as const })),
      ...removeIds.map((roleId, i) => ({ roleId, label: `-${args.remove?.[i] ?? roleId}`, mode: "remove" as const })),
    ];

    const one = (op: (typeof operations)[number]): Promise<unknown> => {
      const route = Routes.guildMemberRole(guildId, userId, op.roleId);
      return op.mode === "add" ? ctx.rest.put(route, undefined, args.reason) : ctx.rest.delete(route, args.reason);
    };

    // One change is one request either way. Several changes collapse into a
    // single PATCH of the full role list instead of a request per role.
    if (operations.length > 1) {
      try {
        const member =
          resolved.member ?? (await ctx.rest.get<APIGuildMember>(Routes.guildMember(guildId, userId)));
        const roles = new Set(member.roles);
        for (const id of addIds) roles.add(id);
        for (const id of removeIds) roles.delete(id);

        await ctx.rest.patch(Routes.guildMember(guildId, userId), { roles: [...roles] }, args.reason);
        return {
          summary: `Applied ${plural(operations.length, "role change")} to member ${userId}.`,
          data: { applied: operations.map((op) => op.label) },
        };
      } catch {
        // All-or-nothing failed; fall through to per-role calls so the
        // report says exactly which role was the problem.
      }
    }

    const results = await mapWithConcurrency(operations, ctx.config.batchConcurrency, one, { signal: ctx.signal });
    const applied = results.flatMap((r, i) => (r.ok ? [operations[i]?.label] : []));
    const failed = results.flatMap((r, i) => (r.ok ? [] : [{ role: operations[i]?.label, error: errorText(r.error) }]));

    // Nothing landed, so reporting success would mislead the agent. One change
    // keeps its own error; several name every role that failed.
    if (applied.length === 0 && failed.length > 0) {
      if (operations.length === 1) throw (results[0] as { error: unknown }).error;
      throw new ToolError(`No role change applied to member ${userId}.`, {
        code: "ROLE_CHANGE_FAILED",
        hint: failed.map((f) => `${f.role}: ${f.error}`).join("; "),
      });
    }

    return {
      summary:
        `Applied ${plural(applied.length, "role change")} to member ${userId}` +
        (failed.length > 0 ? `; ${failed.length} failed.` : "."),
      data: { applied, failed: failed.length > 0 ? failed : undefined },
    };
  },
});
