import type { AnyTool } from "./registry.js";
import * as messages from "./messages.js";
import * as channels from "./channels.js";
import * as members from "./members.js";
import * as roles from "./roles.js";
import * as moderation from "./moderation.js";
import * as guild from "./guild.js";
import * as events from "./events.js";
import * as community from "./community.js";
import { batch } from "./batch.js";

/**
 * Every tool the server exposes, in the order they are advertised to clients.
 *
 * Ordering is deliberate: orientation tools (whoami, list_guilds) come first so
 * a model scanning the list top-down meets the "where am I?" tools before the
 * ones that change things.
 */
export const allTools: readonly AnyTool[] = [
  guild.whoAmI,
  guild.listGuilds,
  guild.getGuild,

  channels.listChannels,
  channels.createChannel,
  channels.editChannel,
  channels.deleteChannel,
  channels.manageThread,
  channels.setChannelPermissions,
  channels.reorderChannels,

  messages.sendMessage,
  messages.sendDirectMessage,
  messages.readMessages,
  messages.searchMessages,
  messages.editMessage,
  messages.deleteMessage,
  messages.reactToMessage,
  messages.pinMessage,
  messages.managePoll,

  members.listMembers,
  members.getMember,
  members.editMember,
  members.manageMemberRoles,

  roles.listRoles,
  roles.manageRole,
  roles.reorderRoles,

  moderation.moderateMember,
  moderation.bulkDelete,
  moderation.listBans,
  moderation.getAuditLog,
  community.manageAutomod,

  guild.createInvite,
  community.manageInvites,
  community.manageScheduledEvents,
  community.manageEmojis,

  events.waitForEvent,
  events.recentEvents,

  batch,
];
