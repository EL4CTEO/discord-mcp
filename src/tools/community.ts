import { z } from "zod";
import {
  AutoModerationActionType,
  AutoModerationRuleEventType,
  AutoModerationRuleKeywordPresetType,
  AutoModerationRuleTriggerType,
  ChannelType,
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
  GuildScheduledEventStatus,
  Routes,
} from "discord-api-types/v10";
import type {
  APIAutoModerationAction,
  APIAutoModerationRule,
  APIAutoModerationRuleTriggerMetadata,
  APIChannel,
  APIEmoji,
  APIExtendedInvite,
  APIGuildScheduledEvent,
  APIGuildScheduledEventUser,
} from "discord-api-types/v10";
import { defineTool } from "./registry.js";
import type { ToolContext } from "./registry.js";
import { plural } from "./util.js";
import { channelTypeName, clip, formatUser } from "../lib/format.js";
import type { Detail } from "../lib/format.js";
import { destructiveDisabled, ToolError } from "../lib/errors.js";
import { loadUpload } from "../lib/upload.js";
import { parseEmoji } from "../lib/text.js";
import { isSnowflake } from "../discord/resolve.js";
import { auditReason, channelRef, detail, guildRef, roleRef } from "../schemas/common.js";

/**
 * Community tools: scheduled events, AutoMod rules, custom emojis and invite links.
 *
 * Every mutating action that Discord lets a bot abuse (deleting, disabling a
 * safety rule, revoking a link) is gated behind DISCORD_ALLOW_DESTRUCTIVE in the
 * handler itself, so list and create stay usable by default.
 */

const snowflake = z.string().regex(/^\d{17,20}$/, "IDs are 17-20 digit snowflakes");

/** Lookup by ID, else by name, mirroring the resolver's rules (resolve.ts keeps its matcher private). */
const looseName = (value: string): string => value.toLowerCase().replace(/[\s_-]+/g, "");

/**
 * Picks one item by ID or name. An ID must match exactly; a name must match
 * exactly, else after loosening case, spaces, _ and -. Failures list the real
 * options so the agent can retry immediately.
 */
function pick<T extends { id: string; name: string }>(
  items: readonly T[],
  query: string,
  kind: string,
  normalise: (value: string) => string = looseName,
): T {
  const wanted = query.trim();
  if (isSnowflake(wanted)) {
    const byId = items.find((item) => item.id === wanted);
    if (byId) return byId;
  }

  const literal = items.filter((item) => item.name === wanted);
  if (literal.length === 1) return literal[0] as T;

  const target = normalise(wanted);
  const matches = items.filter((item) => normalise(item.name) === target);
  if (matches.length === 1) return matches[0] as T;

  if (matches.length === 0) {
    const names = items.slice(0, 25).map((item) => item.name).join(", ");
    throw new ToolError(`No ${kind} named "${wanted}" was found.`, {
      code: "NOT_FOUND",
      hint: names ? `Available ${kind}s: ${names}` : `This server has no ${kind}s.`,
    });
  }

  throw new ToolError(`"${wanted}" matches ${matches.length} ${kind}s, so it is ambiguous.`, {
    code: "AMBIGUOUS",
    hint: `Pass the exact name or the ID. Matches: ${matches
      .slice(0, 15)
      .map((m) => `${m.name} (${m.id})`)
      .join(", ")}`,
  });
}

/** Long lists keep their first few entries in compact output; full returns them all. */
const SAMPLE = 10;
function sampled(values: readonly string[] | undefined, detailLevel: Detail): string[] | undefined {
  if (!values || values.length === 0) return undefined;
  if (detailLevel === "full" || values.length <= SAMPLE) return [...values];
  return [...values.slice(0, SAMPLE), `and ${values.length - SAMPLE} more`];
}

// ---------------------------------------------------------------------------
// Scheduled events
// ---------------------------------------------------------------------------

const EVENT_STATUS = {
  scheduled: GuildScheduledEventStatus.Scheduled,
  active: GuildScheduledEventStatus.Active,
  completed: GuildScheduledEventStatus.Completed,
  canceled: GuildScheduledEventStatus.Canceled,
} as const;

const EVENT_STATUS_NAME: Record<GuildScheduledEventStatus, string> = {
  [GuildScheduledEventStatus.Scheduled]: "scheduled",
  [GuildScheduledEventStatus.Active]: "active",
  [GuildScheduledEventStatus.Completed]: "completed",
  [GuildScheduledEventStatus.Canceled]: "canceled",
};

const EVENT_ENTITY_NAME: Record<GuildScheduledEventEntityType, string> = {
  [GuildScheduledEventEntityType.StageInstance]: "stage",
  [GuildScheduledEventEntityType.Voice]: "voice",
  [GuildScheduledEventEntityType.External]: "external",
};

interface CompactEvent {
  id: string;
  name: string;
  status: string;
  entity: string;
  start: string;
  end?: string;
  location?: string;
  channel_id?: string;
  interested?: number;
  description?: string;
  creator_id?: string;
}

function formatEvent(event: APIGuildScheduledEvent, detailLevel: Detail): CompactEvent {
  const out: CompactEvent = {
    id: event.id,
    name: event.name,
    status: EVENT_STATUS_NAME[event.status],
    entity: EVENT_ENTITY_NAME[event.entity_type],
    start: event.scheduled_start_time,
  };
  if (event.scheduled_end_time) out.end = event.scheduled_end_time;
  if (event.entity_metadata?.location) out.location = event.entity_metadata.location;
  if (event.channel_id) out.channel_id = event.channel_id;
  if (event.user_count !== undefined) out.interested = event.user_count;
  if (detailLevel === "full") {
    if (event.description) out.description = clip(event.description, 1000);
    if (event.creator_id) out.creator_id = event.creator_id;
  }
  return out;
}

/** Discord needs the end after the start; refusing a bad pair here saves a round trip. */
function checkWindow(start: string, end: string | null | undefined): void {
  if (end && Date.parse(end) <= Date.parse(start)) {
    throw new ToolError("end_time must be after start_time.", {
      code: "INVALID_ARGS",
      hint: "Pass an end_time later than start_time, both as ISO 8601 times.",
    });
  }
}

/** A start time in the past would schedule an event that is already overdue, which is never what was meant. */
function checkFuture(start: string): void {
  if (Date.parse(start) <= Date.now()) {
    throw new ToolError("start_time must be in the future.", {
      code: "INVALID_ARGS",
      hint: "Use an ISO time after now, e.g. 2026-12-01T18:00:00Z.",
    });
  }
}

interface Place {
  entity_type: GuildScheduledEventEntityType;
  channel_id: string | null;
  entity_metadata: { location: string } | null;
}

/** Where an event happens: a free-text location (external), or a voice or stage channel. */
async function placeOf(
  ctx: ToolContext,
  guildId: string,
  location: string | undefined,
  channel: string | undefined,
): Promise<Place> {
  if (location !== undefined) {
    return { entity_type: GuildScheduledEventEntityType.External, channel_id: null, entity_metadata: { location } };
  }
  if (channel === undefined) {
    throw new ToolError("Pass `location` for an external event, or `channel` for a voice or stage event.", {
      code: "MISSING_ARG",
    });
  }

  const channelId = await ctx.resolver.channelId(channel, guildId, { exact: true });
  const found = await ctx.resolver.findChannel(guildId, channelId);
  if (!found) {
    throw new ToolError(`Channel ${channel} is not a top-level channel of this server.`, {
      code: "NOT_FOUND",
      hint: "Events can only be hosted by voice or stage channels. Call discord_list_channels for valid channels.",
    });
  }
  if (found.type !== ChannelType.GuildVoice && found.type !== ChannelType.GuildStageVoice) {
    throw new ToolError(`Events can only be hosted by voice or stage channels, not ${channelTypeName(found.type)}.`, {
      code: "INVALID_ARGS",
      hint: "Pass a voice or stage channel, or use `location` for an external event.",
    });
  }

  return {
    entity_type:
      found.type === ChannelType.GuildStageVoice
        ? GuildScheduledEventEntityType.StageInstance
        : GuildScheduledEventEntityType.Voice,
    channel_id: channelId,
    entity_metadata: null,
  };
}

async function listEvents(ctx: ToolContext, guildId: string): Promise<APIGuildScheduledEvent[]> {
  return ctx.rest.get<APIGuildScheduledEvent[]>(Routes.guildScheduledEvents(guildId), { with_user_count: true });
}

/** Just the ID: an ID is used as-is, a name costs one listing. */
async function eventIdOf(ctx: ToolContext, guildId: string, ref: string): Promise<string> {
  const trimmed = ref.trim();
  if (isSnowflake(trimmed)) return trimmed;
  return pick(await listEvents(ctx, guildId), trimmed, "scheduled event").id;
}

/** The whole event, which edit needs to check its times and place. */
async function eventOf(ctx: ToolContext, guildId: string, ref: string): Promise<APIGuildScheduledEvent> {
  const trimmed = ref.trim();
  if (isSnowflake(trimmed)) {
    return ctx.rest.get<APIGuildScheduledEvent>(Routes.guildScheduledEvent(guildId, trimmed));
  }
  return pick(await listEvents(ctx, guildId), trimmed, "scheduled event");
}

export const manageScheduledEvents = defineTool({
  name: "discord_scheduled_events",
  title: "Manage scheduled events",
  missingPermissionHint:
    "Needs Create Events to schedule an event and Manage Events to edit or delete one. Voice and stage events " +
    "also need the bot to see that channel.",
  description:
    "Lists, creates, edits and deletes server scheduled events, and lists who is interested in one.\n\n" +
    "- list (default): every event with status, times, location or channel, and interested count.\n" +
    "- create: needs name and start_time (in the future), plus location (external; also needs end_time) or channel (voice or stage).\n" +
    "- edit: needs event and the fields to change. Setting status to canceled is destructive and needs DISCORD_ALLOW_DESTRUCTIVE=true.\n" +
    "- users: needs event; paged with limit and after.\n" +
    "- delete: needs event; destructive, requires DISCORD_ALLOW_DESTRUCTIVE=true.\n\n" +
    "`event` takes an ID or an exact name. Times are ISO 8601, e.g. 2026-11-01T18:00:00Z.",
  inputSchema: {
    action: z.enum(["list", "create", "edit", "delete", "users"]).default("list"),
    guild: guildRef.optional(),
    event: z.string().min(1).optional().describe("Event ID or exact name. Required for edit, delete and users."),
    name: z.string().min(1).max(100).optional().describe("Event name (new name when editing)."),
    description: z
      .string()
      .max(1000)
      .optional()
      .describe("Event description, up to 1000 characters. When editing, '' clears it."),
    start_time: z
      .iso.datetime({ offset: true })
      .optional()
      .describe("Start time, ISO 8601, e.g. 2026-11-01T18:00:00Z. Must be in the future."),
    end_time: z.iso.datetime({ offset: true }).optional().describe("End time, ISO 8601. Required for external events."),
    location: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe("Where an external event takes place (up to 100 characters). Makes the event External."),
    channel: channelRef.optional().describe("Voice or stage channel that hosts the event. Use instead of location."),
    status: z
      .enum(["scheduled", "active", "completed", "canceled"])
      .optional()
      .describe("edit only: move the event to another state. canceled is destructive and needs DISCORD_ALLOW_DESTRUCTIVE=true."),
    limit: z.number().int().min(1).max(100).default(50).describe("users only: how many to return per page."),
    after: snowflake.optional().describe("users only: the last user ID from the previous page, to continue."),
    detail,
    reason: auditReason,
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  async handler(args, ctx) {
    if (args.action === "delete" && !ctx.config.allowDestructive) {
      throw destructiveDisabled("discord_scheduled_events delete");
    }
    // Cancelling tells everyone interested that the event is off, so it is gated like a delete.
    if (args.action === "edit" && args.status === "canceled" && !ctx.config.allowDestructive) {
      throw destructiveDisabled("discord_scheduled_events cancel");
    }

    const guildId = await ctx.resolver.guildId(args.guild);

    if (args.action === "list") {
      const events = await listEvents(ctx, guildId);
      return {
        summary: `${plural(events.length, "scheduled event")} in server ${guildId}.`,
        data: events.map((event) => formatEvent(event, args.detail)),
      };
    }

    if (args.action === "users") {
      if (!args.event) throw new ToolError("`event` is required to list who is interested.", { code: "MISSING_ARG" });
      const eventId = await eventIdOf(ctx, guildId, args.event);
      const users = await ctx.rest.get<APIGuildScheduledEventUser[]>(
        Routes.guildScheduledEventUsers(guildId, eventId),
        { limit: args.limit, after: args.after },
      );
      const last = users[users.length - 1];
      const more = last && users.length === args.limit ? ` More may follow: pass after="${last.user.id}".` : "";
      return {
        summary: `${plural(users.length, "user")} interested in event ${eventId}.${more}`,
        data: users.map((entry) => formatUser(entry.user)),
      };
    }

    if (args.action === "create") {
      if (!args.name || !args.start_time) {
        throw new ToolError("`name` and `start_time` are required to create an event.", { code: "MISSING_ARG" });
      }
      if ((args.location === undefined) === (args.channel === undefined)) {
        throw new ToolError("Give either `location` (external event) or `channel` (voice or stage), not both or neither.", {
          code: "INVALID_ARGS",
        });
      }
      if (args.location !== undefined && args.end_time === undefined) {
        throw new ToolError("An external event needs `end_time`.", {
          code: "MISSING_ARG",
          hint: "Pass end_time as an ISO 8601 time after start_time.",
        });
      }
      checkFuture(args.start_time);
      checkWindow(args.start_time, args.end_time);

      const place = await placeOf(ctx, guildId, args.location, args.channel);
      const event = await ctx.rest.post<APIGuildScheduledEvent>(
        Routes.guildScheduledEvents(guildId),
        {
          name: args.name,
          privacy_level: GuildScheduledEventPrivacyLevel.GuildOnly,
          scheduled_start_time: args.start_time,
          scheduled_end_time: args.end_time,
          description: args.description || undefined,
          entity_type: place.entity_type,
          channel_id: place.channel_id ?? undefined,
          entity_metadata: place.entity_metadata ?? undefined,
        },
        args.reason,
      );

      return {
        summary: `Created ${EVENT_ENTITY_NAME[event.entity_type]} event "${event.name}" (${event.id}).`,
        data: formatEvent(event, "compact"),
      };
    }

    if (args.action === "edit") {
      if (!args.event) throw new ToolError("`event` is required to edit an event.", { code: "MISSING_ARG" });
      const touched = [
        args.name,
        args.description,
        args.start_time,
        args.end_time,
        args.status,
        args.location,
        args.channel,
      ].some((value) => value !== undefined);
      if (!touched) {
        throw new ToolError("Nothing to change: pass at least one field to update.", { code: "MISSING_ARG" });
      }
      if (args.location !== undefined && args.channel !== undefined) {
        throw new ToolError("Give either `location` or `channel`, not both.", { code: "INVALID_ARGS" });
      }

      if (args.start_time !== undefined) checkFuture(args.start_time);
      const event = await eventOf(ctx, guildId, args.event);
      if (args.start_time !== undefined || args.end_time !== undefined) {
        checkWindow(args.start_time ?? event.scheduled_start_time, args.end_time ?? event.scheduled_end_time);
      }

      const body: Record<string, unknown> = {};
      if (args.name !== undefined) body.name = args.name;
      if (args.description !== undefined) body.description = args.description === "" ? null : args.description;
      if (args.start_time !== undefined) body.scheduled_start_time = args.start_time;
      if (args.end_time !== undefined) body.scheduled_end_time = args.end_time;
      if (args.status !== undefined) body.status = EVENT_STATUS[args.status];

      if (args.location !== undefined || args.channel !== undefined) {
        const place = await placeOf(ctx, guildId, args.location, args.channel);
        if (place.entity_type === GuildScheduledEventEntityType.External && !(args.end_time ?? event.scheduled_end_time)) {
          throw new ToolError("An external event needs an end time.", {
            code: "MISSING_ARG",
            hint: "Pass end_time as well, since this event has none set.",
          });
        }
        body.entity_type = place.entity_type;
        body.channel_id = place.channel_id;
        body.entity_metadata = place.entity_metadata;
      }

      const updated = await ctx.rest.patch<APIGuildScheduledEvent>(
        Routes.guildScheduledEvent(guildId, event.id),
        body,
        args.reason,
      );
      return {
        summary: `Updated scheduled event "${updated.name}" (${updated.id}).`,
        data: formatEvent(updated, "compact"),
      };
    }

    // delete - the only action left. Its gate ran first, before any lookup.
    if (!args.event) throw new ToolError("`event` is required to delete an event.", { code: "MISSING_ARG" });
    const eventId = await eventIdOf(ctx, guildId, args.event);
    await ctx.rest.delete(Routes.guildScheduledEvent(guildId, eventId), args.reason);
    return { summary: `Deleted scheduled event ${eventId}.` };
  },
});

// ---------------------------------------------------------------------------
// AutoMod
// ---------------------------------------------------------------------------

const TRIGGERS = ["keyword", "spam", "keyword_preset", "mention_spam"] as const;
type Trigger = (typeof TRIGGERS)[number];

const TRIGGER_TYPE: Record<Trigger, AutoModerationRuleTriggerType> = {
  keyword: AutoModerationRuleTriggerType.Keyword,
  spam: AutoModerationRuleTriggerType.Spam,
  keyword_preset: AutoModerationRuleTriggerType.KeywordPreset,
  mention_spam: AutoModerationRuleTriggerType.MentionSpam,
};

const PRESETS = ["profanity", "sexual_content", "slurs"] as const;
type Preset = (typeof PRESETS)[number];

const PRESET_TYPE: Record<Preset, AutoModerationRuleKeywordPresetType> = {
  profanity: AutoModerationRuleKeywordPresetType.Profanity,
  sexual_content: AutoModerationRuleKeywordPresetType.SexualContent,
  slurs: AutoModerationRuleKeywordPresetType.Slurs,
};

const ACTION_NAME: Record<AutoModerationActionType, string> = {
  [AutoModerationActionType.BlockMessage]: "block",
  [AutoModerationActionType.SendAlertMessage]: "alert",
  [AutoModerationActionType.Timeout]: "timeout",
  [AutoModerationActionType.BlockMemberInteraction]: "block_interaction",
};

/** Longest timeout Discord accepts for an AutoMod action: 28 days. */
const MAX_TIMEOUT_SECONDS = 2419200;

const triggerOf = (type: number): Trigger | undefined => TRIGGERS.find((t) => TRIGGER_TYPE[t] === type);
const presetOf = (type: number): Preset | undefined => PRESETS.find((p) => PRESET_TYPE[p] === type);

const actionSchema = z.object({
  type: z.enum(["block", "alert", "timeout"]).describe("block: stop the message. alert: post to a channel. timeout: mute the author."),
  custom_message: z.string().max(150).optional().describe("block only: text shown to the author."),
  channel: channelRef.optional().describe("alert only: the channel that receives the alert."),
  duration_seconds: z
    .number()
    .int()
    .min(1)
    .max(MAX_TIMEOUT_SECONDS)
    .optional()
    .describe("timeout only: seconds to mute the author, up to 2419200 (28 days)."),
});

type ActionInput = z.infer<typeof actionSchema>;

/** Trigger settings a caller can pass; each one belongs to particular trigger types. */
interface TriggerArgs {
  keywords?: readonly string[] | undefined;
  regex_patterns?: readonly string[] | undefined;
  allow_list?: readonly string[] | undefined;
  presets?: readonly Preset[] | undefined;
  mention_total_limit?: number | undefined;
  mention_raid_protection?: boolean | undefined;
}

const TRIGGER_FIELD_NAMES: ReadonlyArray<keyof TriggerArgs> = [
  "keywords",
  "regex_patterns",
  "allow_list",
  "presets",
  "mention_total_limit",
  "mention_raid_protection",
];

const TRIGGER_FIELDS: Record<Trigger, ReadonlyArray<keyof TriggerArgs>> = {
  keyword: ["keywords", "regex_patterns", "allow_list"],
  keyword_preset: ["presets", "allow_list"],
  spam: [],
  mention_spam: ["mention_total_limit", "mention_raid_protection"],
};

function withoutUndefined(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

/**
 * The trigger_metadata for a rule, in Discord's wire names. A setting that
 * belongs to another trigger type is refused rather than silently dropped.
 * On create the required settings are checked; on edit they are merged into
 * the existing metadata by the caller, so omitting them keeps what is there.
 */
function triggerSettings(trigger: Trigger, args: TriggerArgs, creating: boolean): Record<string, unknown> | undefined {
  const stray = TRIGGER_FIELD_NAMES.filter((field) => args[field] !== undefined && !TRIGGER_FIELDS[trigger].includes(field));
  if (stray.length > 0) {
    const allowed = TRIGGER_FIELDS[trigger];
    throw new ToolError(`${stray.join(", ")} ${stray.length === 1 ? "does" : "do"} not apply to a ${trigger} rule.`, {
      code: "INVALID_ARGS",
      hint: allowed.length > 0 ? `A ${trigger} rule accepts: ${allowed.join(", ")}.` : `A ${trigger} rule takes no trigger settings.`,
    });
  }

  switch (trigger) {
    case "keyword":
      if (creating && !args.keywords?.length && !args.regex_patterns?.length) {
        throw new ToolError("A keyword rule needs `keywords` or `regex_patterns`.", { code: "MISSING_ARG" });
      }
      // Discord allows 1000 allow-list entries on preset rules but only 100 on keyword rules.
      if ((args.allow_list?.length ?? 0) > 100) {
        throw new ToolError("A keyword rule's allow_list holds at most 100 entries.", { code: "INVALID_ARGS" });
      }
      return withoutUndefined({
        keyword_filter: args.keywords,
        regex_patterns: args.regex_patterns,
        allow_list: args.allow_list,
      });
    case "keyword_preset":
      if (creating && !args.presets?.length) {
        throw new ToolError("A keyword_preset rule needs `presets`: profanity, sexual_content or slurs.", {
          code: "MISSING_ARG",
        });
      }
      return withoutUndefined({
        presets: args.presets?.map((preset) => PRESET_TYPE[preset]),
        allow_list: args.allow_list,
      });
    case "mention_spam":
      if (creating && args.mention_total_limit === undefined) {
        throw new ToolError("A mention_spam rule needs `mention_total_limit` (1-50).", { code: "MISSING_ARG" });
      }
      return withoutUndefined({
        mention_total_limit: args.mention_total_limit,
        mention_raid_protection_enabled: args.mention_raid_protection,
      });
    case "spam":
      return undefined;
  }
}

/** Builds the action list, checking each action's fields against the trigger it will run under. */
async function actionsFor(
  ctx: ToolContext,
  guildId: string,
  actions: readonly ActionInput[],
  trigger: Trigger,
): Promise<APIAutoModerationAction[]> {
  return Promise.all(
    actions.map(async (action): Promise<APIAutoModerationAction> => {
      switch (action.type) {
        case "block":
          if (action.channel !== undefined || action.duration_seconds !== undefined) {
            throw new ToolError("A block action takes only custom_message.", { code: "INVALID_ARGS" });
          }
          return {
            type: AutoModerationActionType.BlockMessage,
            metadata: action.custom_message === undefined ? undefined : { custom_message: action.custom_message },
          };

        case "alert": {
          if (action.channel === undefined) {
            throw new ToolError("An alert action needs `channel`, the channel that receives the alert.", {
              code: "MISSING_ARG",
            });
          }
          if (action.custom_message !== undefined || action.duration_seconds !== undefined) {
            throw new ToolError("An alert action takes only channel.", { code: "INVALID_ARGS" });
          }
          const channelId = await ctx.resolver.channelId(action.channel, guildId, { exact: true });
          return { type: AutoModerationActionType.SendAlertMessage, metadata: { channel_id: channelId } };
        }

        case "timeout":
          if (action.duration_seconds === undefined) {
            throw new ToolError(`A timeout action needs duration_seconds (up to ${MAX_TIMEOUT_SECONDS}).`, {
              code: "MISSING_ARG",
            });
          }
          if (action.channel !== undefined || action.custom_message !== undefined) {
            throw new ToolError("A timeout action takes only duration_seconds.", { code: "INVALID_ARGS" });
          }
          if (trigger !== "keyword" && trigger !== "mention_spam") {
            throw new ToolError(`A timeout action cannot be used with a ${trigger} rule.`, {
              code: "INVALID_ARGS",
              hint: "Timeouts only work with keyword and mention_spam rules. Use block or alert with this trigger.",
            });
          }
          return {
            type: AutoModerationActionType.Timeout,
            metadata: { duration_seconds: action.duration_seconds },
          };
      }
    }),
  );
}

interface AutoModNames {
  roles: ReadonlyMap<string, string>;
  channels: ReadonlyMap<string, string>;
}

function channelNames(channels: readonly APIChannel[]): Map<string, string> {
  return new Map(channels.flatMap((c): Array<[string, string]> => ("name" in c && c.name ? [[c.id, c.name]] : [])));
}

async function namesFor(ctx: ToolContext, guildId: string): Promise<AutoModNames> {
  const [roles, channels] = await Promise.all([ctx.resolver.roleNames(guildId), ctx.resolver.channels(guildId)]);
  return { roles, channels: channelNames(channels) };
}

async function exemptionsOf(
  ctx: ToolContext,
  guildId: string,
  roles: readonly string[] | undefined,
  channels: readonly string[] | undefined,
): Promise<{ exempt_roles?: string[]; exempt_channels?: string[] }> {
  const [exempt_roles, exempt_channels] = await Promise.all([
    roles === undefined
      ? undefined
      : Promise.all(roles.map((role) => ctx.resolver.roleId(role, guildId, { exact: true }))),
    channels === undefined
      ? undefined
      : Promise.all(channels.map((channel) => ctx.resolver.channelId(channel, guildId, { exact: true }))),
  ]);
  // @everyone's role ID is the guild's own ID, so exempting it exempts every member and the rule does nothing.
  if (exempt_roles?.includes(guildId) && !ctx.config.allowDestructive) {
    throw destructiveDisabled("discord_automod exempting @everyone");
  }
  return { exempt_roles, exempt_channels };
}

function describeAction(action: APIAutoModerationAction, channels: ReadonlyMap<string, string>): string {
  const name = ACTION_NAME[action.type];
  if (action.type === AutoModerationActionType.SendAlertMessage && action.metadata?.channel_id) {
    const channelId = action.metadata.channel_id;
    return `alert #${channels.get(channelId) ?? channelId}`;
  }
  if (action.type === AutoModerationActionType.Timeout && action.metadata?.duration_seconds !== undefined) {
    return `timeout ${action.metadata.duration_seconds}s`;
  }
  return name;
}

interface CompactRule {
  id: string;
  name: string;
  enabled: boolean;
  trigger: string;
  actions: string[];
  keywords?: string[];
  regex_patterns?: string[];
  allow_list?: string[];
  presets?: string[];
  mention_total_limit?: number;
  mention_raid_protection?: boolean;
  exempt_roles?: string[];
  exempt_channels?: string[];
}

function formatRule(rule: APIAutoModerationRule, detailLevel: Detail, names: AutoModNames): CompactRule {
  const meta: APIAutoModerationRuleTriggerMetadata = rule.trigger_metadata ?? {};
  const out: CompactRule = {
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled,
    trigger: triggerOf(rule.trigger_type) ?? `type_${rule.trigger_type}`,
    actions: rule.actions.map((action) => describeAction(action, names.channels)),
  };

  const keywords = sampled(meta.keyword_filter, detailLevel);
  if (keywords) out.keywords = keywords;
  const regex = sampled(meta.regex_patterns, detailLevel);
  if (regex) out.regex_patterns = regex;
  const allow = sampled(meta.allow_list, detailLevel);
  if (allow) out.allow_list = allow;
  if (meta.presets && meta.presets.length > 0) {
    out.presets = meta.presets.map((preset) => presetOf(preset) ?? String(preset));
  }
  if (meta.mention_total_limit !== undefined) out.mention_total_limit = meta.mention_total_limit;
  if (meta.mention_raid_protection_enabled !== undefined) {
    out.mention_raid_protection = meta.mention_raid_protection_enabled;
  }
  if (rule.exempt_roles.length > 0) out.exempt_roles = rule.exempt_roles.map((id) => names.roles.get(id) ?? id);
  if (rule.exempt_channels.length > 0) {
    out.exempt_channels = rule.exempt_channels.map((id) => names.channels.get(id) ?? id);
  }
  return out;
}

async function listRules(ctx: ToolContext, guildId: string): Promise<APIAutoModerationRule[]> {
  return ctx.rest.get<APIAutoModerationRule[]>(Routes.guildAutoModerationRules(guildId));
}

const ruleOf = async (ctx: ToolContext, guildId: string, ref: string): Promise<APIAutoModerationRule> =>
  pick(await listRules(ctx, guildId), ref, "auto-moderation rule");

export const manageAutomod = defineTool({
  name: "discord_automod",
  title: "Manage AutoMod rules",
  missingPermissionHint: "Needs Manage Server to list, create, edit or delete AutoMod rules.",
  description:
    "Lists, creates, edits and deletes AutoMod rules that block, alert on or time out messages.\n\n" +
    "- list (default): every rule with its trigger, actions, exemptions and key settings.\n" +
    "- create: needs name and trigger (keyword, spam, keyword_preset or mention_spam). timeout only works with keyword or mention_spam.\n" +
    "- edit: needs rule and the fields to change; the trigger type cannot change.\n" +
    "- delete: needs rule; destructive, requires DISCORD_ALLOW_DESTRUCTIVE=true.\n\n" +
    "Also destructive, each requiring DISCORD_ALLOW_DESTRUCTIVE=true: disabling a rule (enabled=false), replacing its " +
    "actions with ones that have no block or timeout, emptying a keyword rule's filter, and exempting @everyone.\n\n" +
    "`rule` takes an ID or an exact name.",
  inputSchema: {
    action: z.enum(["list", "create", "edit", "delete"]).default("list"),
    guild: guildRef.optional(),
    rule: z.string().min(1).optional().describe("Rule ID or exact name. Required for edit and delete."),
    name: z.string().min(1).max(100).optional().describe("Rule name. Required for create; new name when editing."),
    trigger: z
      .enum(TRIGGERS)
      .optional()
      .describe("create only: what the rule looks for. A rule's trigger cannot be changed afterwards."),
    keywords: z
      .array(z.string().min(1).max(60))
      .max(1000)
      .optional()
      .describe("keyword rules: words or phrases to match, each up to 60 characters."),
    regex_patterns: z
      .array(z.string().min(1).max(260))
      .max(10)
      .optional()
      .describe("keyword rules: regular expressions to match, up to 10."),
    allow_list: z
      .array(z.string().min(1).max(60))
      .max(1000)
      .optional()
      .describe("keyword and keyword_preset rules: words never blocked, each up to 60 characters (keyword: up to 100, keyword_preset: up to 1000)."),
    presets: z
      .array(z.enum(PRESETS))
      .min(1)
      .max(3)
      .optional()
      .describe("keyword_preset rules: built-in word lists to block."),
    mention_total_limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe("mention_spam rules: most mentions one message may contain."),
    mention_raid_protection: z
      .boolean()
      .optional()
      .describe("mention_spam rules: also block raids where many new accounts mention people at once."),
    actions: z
      .array(actionSchema)
      .min(1)
      .optional()
      .describe("What happens on a match. Defaults to a single block action on create."),
    exempt_roles: z.array(roleRef).max(20).optional().describe("Roles the rule ignores, up to 20. Replaces the list."),
    exempt_channels: z
      .array(channelRef)
      .max(50)
      .optional()
      .describe("Channels the rule ignores, up to 50. Replaces the list."),
    enabled: z.boolean().optional().describe("Turn the rule on or off. Defaults to on when created."),
    detail,
    reason: auditReason,
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  async handler(args, ctx) {
    if (args.action === "delete" && !ctx.config.allowDestructive) {
      throw destructiveDisabled("discord_automod delete");
    }
    if (args.action === "edit" && args.enabled === false && !ctx.config.allowDestructive) {
      throw destructiveDisabled("discord_automod edit with enabled=false (disabling a rule)");
    }

    const guildId = await ctx.resolver.guildId(args.guild);

    if (args.action === "list") {
      const [rules, names] = await Promise.all([listRules(ctx, guildId), namesFor(ctx, guildId)]);
      return {
        summary: `${plural(rules.length, "AutoMod rule")} in server ${guildId}.`,
        data: rules.map((rule) => formatRule(rule, args.detail, names)),
      };
    }

    if (args.action === "create") {
      if (!args.name || !args.trigger) {
        throw new ToolError("`name` and `trigger` are required to create a rule.", {
          code: "MISSING_ARG",
          hint: "trigger is one of keyword, spam, keyword_preset or mention_spam.",
        });
      }

      const trigger = args.trigger;
      const settings = triggerSettings(trigger, args, true);
      const actions = await actionsFor(ctx, guildId, args.actions ?? [{ type: "block" }], trigger);
      const exemptions = await exemptionsOf(ctx, guildId, args.exempt_roles, args.exempt_channels);

      const rule = await ctx.rest.post<APIAutoModerationRule>(
        Routes.guildAutoModerationRules(guildId),
        {
          name: args.name,
          event_type: AutoModerationRuleEventType.MessageSend,
          trigger_type: TRIGGER_TYPE[trigger],
          trigger_metadata: settings,
          actions,
          enabled: args.enabled ?? true,
          ...exemptions,
        },
        args.reason,
      );

      return {
        summary: `Created ${trigger} rule "${rule.name}" (${rule.id}).`,
        data: formatRule(rule, args.detail, await namesFor(ctx, guildId)),
      };
    }

    if (args.action === "edit") {
      if (!args.rule) throw new ToolError("`rule` is required to edit a rule.", { code: "MISSING_ARG" });
      if (args.trigger !== undefined) {
        throw new ToolError("A rule's trigger type cannot be changed.", {
          code: "INVALID_ARGS",
          hint: "Delete the rule and create a new one with the trigger you want.",
        });
      }

      const touched = [
        args.name,
        args.enabled,
        args.actions,
        args.exempt_roles,
        args.exempt_channels,
        args.keywords,
        args.regex_patterns,
        args.allow_list,
        args.presets,
        args.mention_total_limit,
        args.mention_raid_protection,
      ].some((value) => value !== undefined);
      if (!touched) {
        throw new ToolError("Nothing to change: pass at least one field to update.", { code: "MISSING_ARG" });
      }

      const current = await ruleOf(ctx, guildId, args.rule);
      const trigger = triggerOf(current.trigger_type);
      if (!trigger) {
        throw new ToolError(`This rule's trigger type (${current.trigger_type}) cannot be edited here.`, {
          code: "INVALID_ARGS",
          hint: "Only keyword, spam, keyword_preset and mention_spam rules can be edited with this tool.",
        });
      }

      const actions = args.actions === undefined ? undefined : await actionsFor(ctx, guildId, args.actions, trigger);
      if (!ctx.config.allowDestructive) {
        // A rule that blocks or times out is the point of AutoMod, so an edit may not strip that enforcement
        // or leave a keyword rule with nothing to match.
        const enforces = (action: APIAutoModerationAction): boolean =>
          action.type === AutoModerationActionType.BlockMessage || action.type === AutoModerationActionType.Timeout;
        if (actions && current.actions.some(enforces) && !actions.some(enforces)) {
          throw destructiveDisabled("discord_automod removing enforcement");
        }
        const keywords = args.keywords ?? current.trigger_metadata?.keyword_filter ?? [];
        const regexes = args.regex_patterns ?? current.trigger_metadata?.regex_patterns ?? [];
        if (trigger === "keyword" && keywords.length === 0 && regexes.length === 0) {
          throw destructiveDisabled("discord_automod emptying the filter");
        }
      }

      const body: Record<string, unknown> = {};
      if (args.name !== undefined) body.name = args.name;
      if (args.enabled !== undefined) body.enabled = args.enabled;
      if (actions) body.actions = actions;
      if (args.exempt_roles !== undefined || args.exempt_channels !== undefined) {
        Object.assign(body, await exemptionsOf(ctx, guildId, args.exempt_roles, args.exempt_channels));
      }

      // Merged into the existing metadata: a PATCH replaces it wholesale, so
      // changing one keyword list must not wipe the others.
      const settings = triggerSettings(trigger, args, false);
      if (settings && Object.keys(settings).length > 0) {
        body.trigger_metadata = { ...current.trigger_metadata, ...settings };
      }

      const rule = await ctx.rest.patch<APIAutoModerationRule>(
        Routes.guildAutoModerationRule(guildId, current.id),
        body,
        args.reason,
      );
      return {
        summary: `Updated rule "${rule.name}" (${rule.id}).`,
        data: formatRule(rule, args.detail, await namesFor(ctx, guildId)),
      };
    }

    // delete - the only action left. Its gate ran first, before any lookup.
    if (!args.rule) throw new ToolError("`rule` is required to delete a rule.", { code: "MISSING_ARG" });
    const ruleId = isSnowflake(args.rule.trim()) ? args.rule.trim() : (await ruleOf(ctx, guildId, args.rule)).id;
    await ctx.rest.delete(Routes.guildAutoModerationRule(guildId, ruleId), args.reason);
    return { summary: `Deleted AutoMod rule ${ruleId}.` };
  },
});

// ---------------------------------------------------------------------------
// Emojis
// ---------------------------------------------------------------------------

/** Discord's limits for a custom emoji image. */
const EMOJI_MAX_BYTES = 256 * 1024;
const EMOJI_NAME = /^[A-Za-z0-9_]{2,32}$/;

const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const EXTENSION_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** The image type Discord will accept, from what the server said or the file extension. */
function imageMime(file: { name: string; contentType?: string | undefined }): string | undefined {
  if (file.contentType && IMAGE_MIME.has(file.contentType)) return file.contentType;
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_MIME[extension];
}

interface CompactEmoji {
  id: string;
  name: string;
  animated?: true;
  mention: string;
  roles?: string[];
  available?: false;
}

function formatEmoji(emoji: APIEmoji, roleNames?: ReadonlyMap<string, string>): CompactEmoji {
  const id = emoji.id ?? "";
  const name = emoji.name ?? "";
  const out: CompactEmoji = { id, name, mention: `<${emoji.animated ? "a" : ""}:${name}:${id}>` };
  if (emoji.animated) out.animated = true;
  if (emoji.roles && emoji.roles.length > 0) out.roles = emoji.roles.map((role) => roleNames?.get(role) ?? role);
  if (emoji.available === false) out.available = false;
  return out;
}

/** An emoji from an ID, a '<:name:id>' or 'name:id' form, or a name looked up in the server. */
async function emojiOf(ctx: ToolContext, guildId: string, ref: string): Promise<{ id: string; name?: string }> {
  const parsed = parseEmoji(ref);

  if ("lookup" in parsed) {
    const emojis = await ctx.resolver.emojis(guildId);
    const named = emojis.flatMap((e) => (e.id && e.name ? [{ id: e.id, name: e.name }] : []));
    return pick(named, parsed.lookup, "emoji", (value) => value.toLowerCase());
  }

  const route = parsed.route;
  if (isSnowflake(route)) return { id: route };
  const custom = /^(\w{2,32}):(\d{17,20})$/.exec(route);
  if (custom?.[2]) return { id: custom[2], name: custom[1] };

  throw new ToolError(`"${ref}" is not a custom server emoji.`, {
    code: "INVALID_ARGS",
    hint: "Pass the emoji's name, its ID, or '<:name:id>'. Unicode emojis cannot be managed here.",
  });
}

export const manageEmojis = defineTool({
  name: "discord_manage_emojis",
  title: "Manage server emojis",
  missingPermissionHint:
    "Needs Create Guild Expressions to add an emoji and Manage Guild Expressions to rename or delete one.",
  description:
    "Lists, adds, renames and deletes custom server emojis.\n\n" +
    "- list (default): every emoji with its ID and a ready-to-send mention.\n" +
    "- create: needs name (2-32 letters, digits or _) and file ({path} or {url}; PNG, JPG, GIF or WebP, max 256 KiB). roles restricts who can use it.\n" +
    "- rename: needs emoji and name. delete: needs emoji; destructive, requires DISCORD_ALLOW_DESTRUCTIVE=true.\n\n" +
    "`emoji` takes an ID, '<:name:id>' or the name.",
  inputSchema: {
    action: z.enum(["list", "create", "rename", "delete"]).default("list"),
    guild: guildRef.optional(),
    emoji: z.string().min(1).optional().describe("rename or delete: the emoji's ID, '<:name:id>' or name."),
    name: z
      .string()
      .regex(EMOJI_NAME, "Emoji names are 2-32 letters, digits or underscores.")
      .optional()
      .describe("New emoji name for create and rename."),
    file: z
      .object({
        path: z.string().min(1).optional().describe("Absolute path to a local image."),
        url: z.string().min(1).optional().describe("Public http(s) URL of an image."),
      })
      .refine((f) => (f.path === undefined) !== (f.url === undefined), "Give exactly one of path or url.")
      .optional()
      .describe("create only: the image, as {path} or {url}. PNG, JPG, GIF or WebP, max 256 KiB."),
    roles: z.array(roleRef).max(20).optional().describe("create only: restrict the emoji to these roles."),
    reason: auditReason,
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  async handler(args, ctx) {
    if (args.action === "delete" && !ctx.config.allowDestructive) {
      throw destructiveDisabled("discord_manage_emojis delete");
    }

    const guildId = await ctx.resolver.guildId(args.guild);

    if (args.action === "list") {
      const [emojis, roleNames] = await Promise.all([ctx.resolver.emojis(guildId), ctx.resolver.roleNames(guildId)]);
      return {
        summary: `${plural(emojis.length, "emoji")} in server ${guildId}.`,
        data: emojis.map((emoji) => formatEmoji(emoji, roleNames)),
      };
    }

    if (args.action === "create") {
      if (!args.name || !args.file) {
        throw new ToolError("`name` and `file` are required to add an emoji.", { code: "MISSING_ARG" });
      }

      const file = await loadUpload(
        { path: args.file.path, url: args.file.url },
        { roots: ctx.config.uploadDirs, signal: ctx.signal, secrets: [ctx.config.token], maxBytes: EMOJI_MAX_BYTES },
      );
      const bytes = file.data instanceof Uint8Array ? file.data : Buffer.from(String(file.data));
      if (bytes.byteLength > EMOJI_MAX_BYTES) {
        throw new ToolError(
          `"${file.name}" is ${Math.ceil(bytes.byteLength / 1024)} KiB, over Discord's 256 KiB emoji limit.`,
          { code: "FILE_TOO_LARGE", hint: "Shrink the image, for example to 128x128 pixels, and try again." },
        );
      }

      const mime = imageMime(file);
      if (!mime) {
        throw new ToolError(`"${file.name}" is not a PNG, JPG, GIF or WebP image.`, {
          code: "INVALID_ARGS",
          hint: "Emoji images must be PNG, JPG, GIF or WebP.",
        });
      }

      const roles = args.roles === undefined
        ? undefined
        : await Promise.all(args.roles.map((role) => ctx.resolver.roleId(role, guildId, { exact: true })));
      const image = `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;

      const emoji = await ctx.rest.post<APIEmoji>(
        Routes.guildEmojis(guildId),
        { name: args.name, image, roles },
        args.reason,
      );
      ctx.resolver.invalidate(guildId);
      return { summary: `Added emoji :${emoji.name}: (${emoji.id}).`, data: formatEmoji(emoji) };
    }

    if (args.action === "rename") {
      if (!args.emoji || !args.name) {
        throw new ToolError("`emoji` and `name` are required to rename an emoji.", { code: "MISSING_ARG" });
      }
      const target = await emojiOf(ctx, guildId, args.emoji);
      const emoji = await ctx.rest.patch<APIEmoji>(
        Routes.guildEmoji(guildId, target.id),
        { name: args.name },
        args.reason,
      );
      ctx.resolver.invalidate(guildId);
      return { summary: `Renamed emoji ${target.id} to :${emoji.name}:.`, data: formatEmoji(emoji) };
    }

    // delete - the only action left. Its gate ran first, before any lookup.
    if (!args.emoji) throw new ToolError("`emoji` is required to delete an emoji.", { code: "MISSING_ARG" });
    const target = await emojiOf(ctx, guildId, args.emoji);
    await ctx.rest.delete(Routes.guildEmoji(guildId, target.id), args.reason);
    ctx.resolver.invalidate(guildId);
    return { summary: `Deleted emoji ${target.id}${target.name ? ` (:${target.name}:)` : ""}.` };
  },
});

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

const INVITE_CODE = /^[A-Za-z0-9-]{2,32}$/;
const INVITE_LINK = /^(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite)\/([^/?#\s]+)/i;

/** A bare code, or the code from a discord.gg / discord.com/invite link. */
function inviteCode(input: string): string {
  const trimmed = input.trim();
  const code = INVITE_LINK.exec(trimmed)?.[1] ?? trimmed;
  if (!INVITE_CODE.test(code)) {
    throw new ToolError(`"${input}" is not a valid invite code or link.`, {
      code: "INVALID_ARGS",
      hint: "Pass the code (for example abc123) or a link such as https://discord.gg/abc123.",
    });
  }
  return code;
}

interface CompactInvite {
  code: string;
  url: string;
  channel?: string;
  inviter?: string;
  uses: number;
  max_uses: number;
  expires_at?: string;
  temporary?: true;
}

function formatInvite(invite: APIExtendedInvite): CompactInvite {
  const out: CompactInvite = {
    code: invite.code,
    url: `https://discord.gg/${invite.code}`,
    uses: invite.uses,
    max_uses: invite.max_uses,
  };
  const channel = invite.channel?.name ?? invite.channel?.id;
  if (channel) out.channel = channel;
  if (invite.inviter) out.inviter = invite.inviter.username;
  if (invite.expires_at) out.expires_at = invite.expires_at;
  if (invite.temporary) out.temporary = true;
  return out;
}

export const manageInvites = defineTool({
  name: "discord_manage_invites",
  title: "Manage invite links",
  missingPermissionHint:
    "Listing invites needs Manage Server. Revoking needs Manage Channels on the invite's channel.",
  description:
    "Lists the server's invite links and revokes them.\n\n" +
    "- list (default): every invite with its link, channel, inviter, uses and expiry. max_uses 0 means no limit.\n" +
    "- revoke: needs code, the code or a discord.gg / discord.com/invite link. Destructive: requires DISCORD_ALLOW_DESTRUCTIVE=true.\n\n" +
    "Revoke works on any invite the bot can manage, so `guild` only matters for list.",
  inputSchema: {
    action: z.enum(["list", "revoke"]).default("list"),
    guild: guildRef.optional(),
    code: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("revoke only: the invite code, or a discord.gg or discord.com/invite link."),
    reason: auditReason,
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  async handler(args, ctx) {
    if (args.action === "revoke" && !ctx.config.allowDestructive) {
      throw destructiveDisabled("discord_manage_invites revoke");
    }

    if (args.action === "list") {
      const guildId = await ctx.resolver.guildId(args.guild);
      const invites = await ctx.rest.get<APIExtendedInvite[]>(Routes.guildInvites(guildId));
      return {
        summary: `${plural(invites.length, "invite")} in server ${guildId}.`,
        data: invites.map(formatInvite),
      };
    }

    // revoke - the only action left. Its gate ran first.
    if (!args.code) throw new ToolError("`code` is required to revoke an invite.", { code: "MISSING_ARG" });
    const code = inviteCode(args.code);
    await ctx.rest.delete(Routes.invite(encodeURIComponent(code)), args.reason);
    return { summary: `Revoked invite https://discord.gg/${code}.` };
  },
});
