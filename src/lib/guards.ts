import { PermissionFlagsBits } from "discord-api-types/v10";
import { ToolError } from "./errors.js";
import { permissionNames } from "../schemas/permissions.js";

/**
 * Permissions that hand over control of a server, or of its members.
 *
 * Granting one is as consequential as a ban: a role with Administrator or
 * Manage Roles can be used to take the server over, and the request to grant
 * it may come from text an attacker posted in a channel the agent read. So
 * these grants sit behind the same switch as the destructive tools.
 */
const ELEVATED: bigint =
  PermissionFlagsBits.Administrator |
  PermissionFlagsBits.ManageGuild |
  PermissionFlagsBits.ManageRoles |
  PermissionFlagsBits.ManageChannels |
  PermissionFlagsBits.ManageWebhooks |
  PermissionFlagsBits.ManageMessages |
  PermissionFlagsBits.ManageThreads |
  PermissionFlagsBits.ManageNicknames |
  PermissionFlagsBits.ManageGuildExpressions |
  PermissionFlagsBits.ManageEvents |
  PermissionFlagsBits.BanMembers |
  PermissionFlagsBits.KickMembers |
  PermissionFlagsBits.ModerateMembers |
  PermissionFlagsBits.MuteMembers |
  PermissionFlagsBits.DeafenMembers |
  PermissionFlagsBits.MoveMembers |
  PermissionFlagsBits.MentionEveryone |
  PermissionFlagsBits.ViewAuditLog;

/** The elevated permissions contained in a bitfield, by name. */
export function elevatedIn(bits: string | bigint | undefined): string[] {
  if (bits === undefined) return [];
  let value: bigint;
  try {
    value = typeof bits === "bigint" ? bits : BigInt(bits);
  } catch {
    return [];
  }
  const elevated = value & ELEVATED;
  return elevated === 0n ? [] : permissionNames(elevated);
}

/**
 * Refuses a grant of elevated permissions unless destructive actions are
 * enabled. `what` names the grant for the error, e.g. 'role "Helpers"'.
 */
export function assertMayGrant(bits: string | bigint | undefined, allowDestructive: boolean, what: string): void {
  if (allowDestructive) return;
  const elevated = elevatedIn(bits);
  if (elevated.length === 0) return;

  throw new ToolError(`Refused: granting ${elevated.join(", ")} to ${what} needs destructive actions enabled.`, {
    code: "ELEVATED_PERMISSION",
    hint:
      "Administrative and moderation permissions can be used to take over a server, so granting them is gated " +
      "like bans and deletes. The operator can set DISCORD_ALLOW_DESTRUCTIVE=true, or grant it by hand in " +
      "Server Settings -> Roles.",
  });
}
