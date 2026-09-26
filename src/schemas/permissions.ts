import { PermissionFlagsBits } from "discord-api-types/v10";
import { z } from "zod";

/**
 * Channel-level permissions, by their Discord UI names.
 *
 * Deliberately a curated subset: these are the ones that mean something as a
 * per-channel overwrite. Guild-wide permissions such as Administrator or Manage
 * Guild cannot be overwritten on a channel, so offering them would only invite
 * silent no-ops.
 */
export const CHANNEL_PERMISSIONS = {
  ViewChannel: PermissionFlagsBits.ViewChannel,
  SendMessages: PermissionFlagsBits.SendMessages,
  SendMessagesInThreads: PermissionFlagsBits.SendMessagesInThreads,
  CreatePublicThreads: PermissionFlagsBits.CreatePublicThreads,
  CreatePrivateThreads: PermissionFlagsBits.CreatePrivateThreads,
  ManageThreads: PermissionFlagsBits.ManageThreads,
  EmbedLinks: PermissionFlagsBits.EmbedLinks,
  AttachFiles: PermissionFlagsBits.AttachFiles,
  AddReactions: PermissionFlagsBits.AddReactions,
  UseExternalEmojis: PermissionFlagsBits.UseExternalEmojis,
  MentionEveryone: PermissionFlagsBits.MentionEveryone,
  ManageMessages: PermissionFlagsBits.ManageMessages,
  PinMessages: PermissionFlagsBits.PinMessages,
  ReadMessageHistory: PermissionFlagsBits.ReadMessageHistory,
  SendPolls: PermissionFlagsBits.SendPolls,
  UseApplicationCommands: PermissionFlagsBits.UseApplicationCommands,
  ManageChannels: PermissionFlagsBits.ManageChannels,
  ManageRoles: PermissionFlagsBits.ManageRoles,
  CreateInstantInvite: PermissionFlagsBits.CreateInstantInvite,
  Connect: PermissionFlagsBits.Connect,
  Speak: PermissionFlagsBits.Speak,
  Stream: PermissionFlagsBits.Stream,
  MuteMembers: PermissionFlagsBits.MuteMembers,
  DeafenMembers: PermissionFlagsBits.DeafenMembers,
  MoveMembers: PermissionFlagsBits.MoveMembers,
} as const;

export type ChannelPermission = keyof typeof CHANNEL_PERMISSIONS;

const CHANNEL_NAMES = Object.keys(CHANNEL_PERMISSIONS) as [ChannelPermission, ...ChannelPermission[]];

export const channelPermissionList = z
  .array(z.enum(CHANNEL_NAMES))
  .max(CHANNEL_NAMES.length)
  .describe('Permission names, e.g. ["ViewChannel","SendMessages"].');

/** Combines channel permission names into the decimal bitfield string Discord expects. */
export function toBitfield(names: readonly ChannelPermission[] | undefined): string {
  if (!names || names.length === 0) return "0";
  return names.reduce((acc, name) => acc | CHANNEL_PERMISSIONS[name], 0n).toString();
}

/** Every permission Discord defines, for role-level grants. */
type PermissionName = keyof typeof PermissionFlagsBits;
const ALL_NAMES = Object.keys(PermissionFlagsBits) as [PermissionName, ...PermissionName[]];

/**
 * Role permissions as either names or a raw bitfield.
 *
 * Names are what a person or model actually thinks in; the bitfield stays
 * accepted for copying an existing role's permissions verbatim.
 */
export const rolePermissions = z
  .union([z.array(z.enum(ALL_NAMES)).max(ALL_NAMES.length), z.string().regex(/^\d+$/)])
  .describe(
    'Permission names such as ["ManageMessages","KickMembers"], or a decimal bitfield string. ' +
      "This REPLACES the role's permissions. Pass [] to strip them all.",
  );

export function rolePermissionBits(input: readonly PermissionName[] | string | undefined): string | undefined {
  if (input === undefined) return undefined;
  if (typeof input === "string") return input;
  return input.reduce((acc, name) => acc | PermissionFlagsBits[name], 0n).toString();
}

/**
 * Decodes a bitfield into permission names. Administrator implies everything,
 * so it is reported alone instead of drowning out the useful signal.
 */
export function permissionNames(bitfield: string | bigint): string[] {
  let bits: bigint;
  try {
    bits = typeof bitfield === "bigint" ? bitfield : BigInt(bitfield);
  } catch {
    return [];
  }

  if ((bits & PermissionFlagsBits.Administrator) !== 0n) return ["Administrator"];
  return CANONICAL.filter(([, bit]) => (bits & bit) !== 0n).map(([name]) => name);
}

/**
 * One name per bit. Discord keeps deprecated aliases around (for example
 * ManageEmojisAndStickers and ManageGuildExpressions share a bit), and listing
 * both would read as two separate grants.
 */
const CANONICAL: ReadonlyArray<readonly [string, bigint]> = [
  ...new Map(ALL_NAMES.map((name) => [PermissionFlagsBits[name], name] as const)).entries(),
].map(([bit, name]) => [name, bit] as const);
