import { z } from "zod";
import { Routes } from "discord-api-types/v10";
import type { APIGuildMember, APIRole, APIRoleColors } from "discord-api-types/v10";
import { defineTool } from "./registry.js";
import { plural } from "./util.js";
import { formatRole } from "../lib/format.js";
import { assertMayGrant } from "../lib/guards.js";
import { destructiveDisabled, ToolError } from "../lib/errors.js";
import { auditReason, detail, guildRef, roleRef } from "../schemas/common.js";
import { rolePermissionBits, rolePermissions } from "../schemas/permissions.js";

const colour = z
  .union([z.string().regex(/^#?[0-9a-fA-F]{6}$/), z.number().int().min(0).max(0xffffff)])
  .describe("Role colour, e.g. '#5865F2'.");

function toColour(input: string | number | undefined): number | undefined {
  if (input === undefined) return undefined;
  return typeof input === "number" ? input : Number.parseInt(input.replace("#", ""), 16);
}

/**
 * Discord deprecated the single `color` field in favour of a colours object.
 * A secondary colour makes the role a gradient, so it rides on the primary one.
 */
function toColors(primary: string | number | undefined, secondary: string | number | undefined): Partial<APIRoleColors> | undefined {
  if (primary === undefined) return undefined;
  const colors: Partial<APIRoleColors> = { primary_color: toColour(primary) };
  if (secondary !== undefined) colors.secondary_color = toColour(secondary);
  return colors;
}

export const listRoles = defineTool({
  name: "discord_list_roles",
  title: "List server roles",
  description:
    "Lists every role in a server, highest first. detail='full' adds each role's permissions by name.\n\n" +
    "Position matters: a bot can only assign, edit or delete roles BELOW its own highest role. Check this " +
    "listing first when a role operation fails with a permissions error.",
  inputSchema: { guild: guildRef.optional(), detail },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async handler(args, ctx) {
    const guildId = await ctx.resolver.guildId(args.guild);
    const roles = await ctx.resolver.roles(guildId);
    const sorted = [...roles].sort((a, b) => b.position - a.position);

    return {
      summary: `${plural(sorted.length, "role")} in server ${guildId}, highest first.`,
      data: sorted.map((r) => formatRole(r, args.detail)),
    };
  },
});

export const manageRole = defineTool({
  name: "discord_manage_role",
  bulkArgs: ["name", "role"],
  missingPermissionHint:
    "Needs Manage Roles, and the bot role must sit ABOVE the role being changed in Server Settings -> Roles. " +
    "A bot can only grant permissions it holds itself.",
  title: "Create, edit or delete a role",
  description:
    "Manages roles themselves (use discord_manage_member_roles to assign them to people).\n\n" +
    "- create: needs `name`.\n" +
    "- edit: needs `role`, plus the fields to change.\n" +
    "- delete: needs `role`; destructive, requires DISCORD_ALLOW_DESTRUCTIVE=true.\n\n" +
    "`permissions` takes names like ['ManageMessages','KickMembers']. A server holds at most 250 roles.",
  inputSchema: {
    action: z.enum(["create", "edit", "delete"]),
    guild: guildRef.optional(),
    role: roleRef.optional().describe("Target role for edit and delete."),
    name: z.string().min(1).max(100).optional().describe("Role name (new name when editing)."),
    color: colour.optional(),
    secondary_color: colour.optional().describe("Second colour for a gradient role. Needs color."),
    hoist: z.boolean().optional().describe("Show members with this role separately in the member list."),
    mentionable: z.boolean().optional().describe("Allow anyone to @mention this role."),
    permissions: rolePermissions.optional(),
    reason: auditReason,
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  async handler(args, ctx) {
    if (args.secondary_color !== undefined && args.color === undefined) {
      throw new ToolError("`secondary_color` needs `color` as well, since it is the gradient's other end.", {
        code: "MISSING_ARG",
      });
    }

    const guildId = await ctx.resolver.guildId(args.guild);
    const body = {
      name: args.name,
      colors: toColors(args.color, args.secondary_color),
      hoist: args.hoist,
      mentionable: args.mentionable,
      permissions: rolePermissionBits(args.permissions),
    };

    if (args.action === "create") {
      if (!args.name) throw new ToolError("`name` is required to create a role.", { code: "MISSING_ARG" });

      // A role carrying Administrator or Manage Roles is a route to taking over
      // the server, so creating one is gated like the destructive actions.
      assertMayGrant(body.permissions, ctx.config.allowDestructive, `role "${args.name}"`);
      const role = await ctx.rest.post<APIRole>(Routes.guildRoles(guildId), body, args.reason);
      ctx.resolver.upsertRole(guildId, role);
      return { summary: `Created role "${role.name}" (${role.id}).`, data: formatRole(role, "full") };
    }

    if (!args.role) {
      throw new ToolError(`\`role\` is required to ${args.action} a role.`, {
        code: "MISSING_ARG",
        hint: "Call discord_list_roles to see available roles.",
      });
    }

    // Only the delete branch is destructive, so the gate lives here rather than
    // on the tool as a whole - create and edit stay usable by default. It runs
    // before resolution so a refused call costs no API request.
    if (args.action === "delete" && !ctx.config.allowDestructive) {
      throw destructiveDisabled("discord_manage_role delete");
    }

    const roleId = await ctx.resolver.roleId(args.role, guildId, { exact: args.action === "delete" });

    // Editing can grant permissions too. Only bits the role does not already
    // hold count, so restating a moderator role's existing powers stays allowed.
    if (body.permissions !== undefined && !ctx.config.allowDestructive) {
      // Read fresh: a stale copy holding more bits than the role now has would let new grants pass as old ones.
      const current = (await ctx.rest.get<APIRole>(Routes.guildRole(guildId, roleId))).permissions;
      assertMayGrant(BigInt(body.permissions) & ~BigInt(current), false, `role "${args.role}"`);
    }

    if (args.action === "delete") {
      await ctx.rest.delete(Routes.guildRole(guildId, roleId), args.reason);
      ctx.resolver.removeRole(guildId, roleId);
      return { summary: `Deleted role ${args.role} (${roleId}).` };
    }

    if (Object.values(body).every((v) => v === undefined)) {
      throw new ToolError("Nothing to change: pass name, color, hoist, mentionable or permissions.", {
        code: "MISSING_ARG",
      });
    }

    const role = await ctx.rest.patch<APIRole>(Routes.guildRole(guildId, roleId), body, args.reason);
    ctx.resolver.upsertRole(guildId, role);
    return { summary: `Updated role "${role.name}".`, data: formatRole(role, "full") };
  },
});

export const reorderRoles = defineTool({
  name: "discord_reorder_roles",
  title: "Reorder the role hierarchy",
  description:
    "Sets the vertical order of roles, highest first.\n\n" +
    "Order is not cosmetic: a role can only moderate, assign or edit roles BELOW it, and hoisted roles appear " +
    "in the member list in this order.\n\n" +
    "Listed roles are placed directly below the bot's own highest role (Discord forbids a bot moving anything " +
    "above itself); roles left out keep their relative order beneath them.",
  inputSchema: {
    guild: guildRef.optional(),
    order: z
      .array(roleRef)
      .min(2)
      .max(50)
      .describe("Roles from highest to lowest, e.g. ['Admin','Moderator','Helper','Member']."),
    reason: auditReason,
  },
  missingPermissionHint: "Needs Manage Roles, and every role being moved must sit below the bot's own highest role.",
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async handler(args, ctx) {
    const guildId = await ctx.resolver.guildId(args.guild);
    const [allRoles, ids, selfId] = await Promise.all([
      ctx.resolver.roles(guildId),
      Promise.all(args.order.map((role) => ctx.resolver.roleId(role, guildId))),
      ctx.resolver.selfId(),
    ]);

    const byId = new Map(allRoles.map((r) => [r.id, r]));
    const nameOf = (id: string): string => byId.get(id)?.name ?? id;

    const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
    if (duplicate) {
      throw new ToolError(`"${nameOf(duplicate)}" appears more than once in order.`, {
        code: "DUPLICATE_ROLE",
        hint: "List each role exactly once.",
      });
    }
    if (ids.includes(guildId)) {
      throw new ToolError("@everyone is always the lowest role and cannot be moved.", { code: "INVALID_ARGS" });
    }

    const self = await ctx.rest.get<APIGuildMember>(Routes.guildMember(guildId, selfId));
    const botTop = Math.max(0, ...self.roles.map((id) => byId.get(id)?.position ?? 0));

    const ceiling = botTop - 1;
    if (ceiling < ids.length) {
      // A brand-new server leaves every role sharing position 1, where Discord
      // breaks the tie by age. That looks ordered in the UI but is not, and no
      // slot exists beneath the bot until someone drags a role for real.
      const tied = allRoles.filter((r) => r.position === botTop && r.id !== guildId).length;
      throw new ToolError(
        tied > 1
          ? `All ${tied} roles share position ${botTop}, including the bot's own, so there is no slot beneath it to order into.`
          : `Not enough room below the bot to order ${ids.length} roles (only ${Math.max(ceiling, 0)} slots).`,
        {
          code: "NO_ROOM",
          hint:
            tied > 1
              ? "Discord only assigns real positions once a role is moved by hand. Open Server Settings -> Roles, " +
                "drag the bot's role to the top, and run this again."
              : "Drag the bot's role higher in Server Settings -> Roles, then run this again.",
        },
      );
    }

    const tooHigh = ids.filter((id) => (byId.get(id)?.position ?? 0) >= botTop);
    if (tooHigh.length > 0) {
      throw new ToolError(`These roles sit at or above the bot's own role: ${tooHigh.map(nameOf).join(", ")}.`, {
        code: "ROLE_TOO_HIGH",
        hint: "Drag the bot's role above them in Server Settings -> Roles, then run this again.",
      });
    }

    // Every movable role below the bot, laid out top-down: the listed ones
    // first in the requested order, then the rest in their current order.
    const listed = new Set(ids);
    const rest = allRoles
      .filter((r) => r.id !== guildId && r.position < botTop && !listed.has(r.id))
      .sort((a, b) => b.position - a.position || (a.id < b.id ? -1 : 1))
      .map((r) => r.id);
    const layout = [...ids, ...rest];
    if (layout.length > ceiling) {
      // Positions below the bot are 1..ceiling; any role past that would be
      // clamped onto a position already taken, and the order would silently break.
      throw new ToolError(`Only ${ceiling} positions sit below the bot, but ${layout.length} roles need one.`, {
        code: "NO_ROOM",
        hint: "Drag the roles apart once in Server Settings -> Roles, then run this again.",
      });
    }

    const positions = layout
      .map((id, index) => ({ id, position: Math.max(1, ceiling - index) }))
      .filter((p) => byId.get(p.id)?.position !== p.position);

    const updated =
      positions.length > 0
        ? await ctx.rest.patch<APIRole[]>(Routes.guildRoles(guildId), positions, args.reason)
        : allRoles;
    ctx.resolver.setRoles(guildId, updated);

    const ranked = [...updated]
      .sort((a, b) => b.position - a.position)
      .map((r) => ({ name: r.name, position: r.position }));

    return {
      summary: `Reordered ${plural(ids.length, "role")}; highest is now "${args.order[0]}".`,
      data: ranked,
    };
  },
});
