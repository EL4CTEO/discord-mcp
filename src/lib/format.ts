import { ChannelType, MessageReferenceType, MessageType } from "discord-api-types/v10";
import { permissionNames } from "../schemas/permissions.js";
import type {
  APIChannel,
  APIEmbed,
  APIGuild,
  APIGuildMember,
  APIMessage,
  APIPoll,
  APIRole,
  APIUser,
} from "discord-api-types/v10";

/** How much of each object to return. Compact is the default everywhere. */
export type Detail = "compact" | "full";

const CHANNEL_TYPE_NAMES: Readonly<Partial<Record<ChannelType, string>>> = {
  [ChannelType.GuildText]: "text",
  [ChannelType.DM]: "dm",
  [ChannelType.GuildVoice]: "voice",
  [ChannelType.GroupDM]: "group_dm",
  [ChannelType.GuildCategory]: "category",
  [ChannelType.GuildAnnouncement]: "announcement",
  [ChannelType.AnnouncementThread]: "announcement_thread",
  [ChannelType.PublicThread]: "public_thread",
  [ChannelType.PrivateThread]: "private_thread",
  [ChannelType.GuildStageVoice]: "stage",
  [ChannelType.GuildDirectory]: "directory",
  [ChannelType.GuildForum]: "forum",
  [ChannelType.GuildMedia]: "media",
};

export function channelTypeName(type: ChannelType): string {
  return CHANNEL_TYPE_NAMES[type] ?? `unknown(${type})`;
}

export const THREAD_TYPES: readonly ChannelType[] = [
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  ChannelType.AnnouncementThread,
];

/** Discord snowflakes encode their creation time (ms since epoch) in the high bits. */
export function snowflakeMs(id: string): number | undefined {
  try {
    const ms = Number((BigInt(id) >> 22n) + 1_420_070_400_000n);
    return Number.isFinite(ms) ? ms : undefined;
  } catch {
    return undefined;
  }
}

export function snowflakeToDate(id: string): string | undefined {
  const ms = snowflakeMs(id);
  return ms === undefined ? undefined : new Date(ms).toISOString();
}

/** Clamp long free text so one noisy message cannot eat the context window. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = max - 1;
  // Ending on a lone high surrogate would leave half an emoji behind.
  const before = text.charCodeAt(cut - 1);
  if (before >= 0xd800 && before <= 0xdbff) cut -= 1;
  return `${text.slice(0, cut)}\u2026`;
}

export interface CompactUser {
  id: string;
  username: string;
  display_name?: string;
  bot?: boolean;
}

export function formatUser(user: APIUser): CompactUser {
  const out: CompactUser = { id: user.id, username: user.username };
  if (user.global_name) out.display_name = user.global_name;
  if (user.bot) out.bot = true;
  return out;
}

export interface CompactMessage {
  id: string;
  author: string;
  author_id: string;
  content: string;
  created_at: string;
  edited?: boolean;
  pinned?: boolean;
  kind?: string;
  /** Set on a forward; its text, attachments and embeds are the original's. */
  forwarded?: boolean;
  forwarded_from?: { channel_id: string; message_id?: string | undefined };
  attachments?: Array<{ name: string; url: string; size: number }>;
  embeds?: CompactEmbed[];
  poll?: CompactPoll;
  reactions?: Array<{ emoji: string; count: number }>;
  reply_to?: string;
  thread_id?: string;
}

export interface CompactEmbed {
  title?: string;
  description?: string;
  url?: string;
  fields?: Array<{ name: string; value: string }>;
}

export interface CompactPoll {
  question: string;
  answers: Array<{ id: number; text: string; votes?: number }>;
  expires_at: string | null;
  finalized?: boolean;
}

/** Question and answers, with vote counts once Discord reports them. */
export function formatPoll(poll: APIPoll): CompactPoll {
  const counts = new Map<number, number>(poll.results?.answer_counts.map((c): [number, number] => [c.id, c.count]));
  const answers = poll.answers.map((answer) => {
    const out: CompactPoll["answers"][number] = { id: answer.answer_id, text: answer.poll_media.text ?? "" };
    if (poll.results) out.votes = counts.get(answer.answer_id) ?? 0;
    return out;
  });

  const out: CompactPoll = { question: poll.question.text ?? "", answers, expires_at: poll.expiry };
  if (poll.results) out.finalized = poll.results.is_finalized;
  return out;
}

/**
 * Embeds are where bots put their actual text, so reporting only a count would
 * leave an agent blind to most bot output. Compact keeps the headline; full
 * adds the fields. A fields-only embed (common for status cards) keeps a few
 * fields in compact mode, or it would come out empty.
 */
function formatEmbed(embed: APIEmbed, detail: Detail): CompactEmbed {
  const out: CompactEmbed = {};
  if (embed.title) out.title = embed.title;
  if (embed.description) out.description = clip(embed.description, detail === "full" ? 4096 : 300);
  if (embed.url) out.url = embed.url;

  const fields = embed.fields ?? [];
  if (detail === "full" && fields.length > 0) {
    out.fields = fields.map((f) => ({ name: f.name, value: clip(f.value, 1024) }));
  } else if (!embed.title && !embed.description && fields.length > 0) {
    out.fields = fields.slice(0, 5).map((f) => ({ name: f.name, value: clip(f.value, 200) }));
  }
  return out;
}

/** Plain messages and replies need no label; joins, pins, boosts etc. do. */
const ORDINARY_TYPES = new Set<MessageType>([MessageType.Default, MessageType.Reply]);

/** The parts of a message that carry its text. */
type MessageBody = Pick<APIMessage, "content" | "attachments" | "embeds">;

/**
 * A forwarded message has no text of its own: Discord copies the original into
 * a snapshot, and that snapshot is what the reader needs to see.
 */
function bodyOf(message: APIMessage): MessageBody {
  if (message.message_reference?.type !== MessageReferenceType.Forward) return message;
  const snapshot = message.message_snapshots?.[0]?.message;
  if (!snapshot) return message;
  // Snapshots are partial; a missing list must not crash a whole read or search.
  return { ...snapshot, content: snapshot.content ?? "", embeds: snapshot.embeds ?? [], attachments: snapshot.attachments ?? [] };
}

export function formatMessage(message: APIMessage, detail: Detail = "compact"): CompactMessage {
  const body = bodyOf(message);
  const out: CompactMessage = {
    id: message.id,
    author: message.author.global_name ?? message.author.username,
    author_id: message.author.id,
    content: clip(body.content ?? "", detail === "full" ? 4000 : 500),
    created_at: message.timestamp,
  };

  if (!ORDINARY_TYPES.has(message.type)) out.kind = MessageType[message.type] ?? `type_${message.type}`;
  if (message.edited_timestamp) out.edited = true;
  if (message.pinned) out.pinned = true;

  const reference = message.message_reference;
  if (reference?.type === MessageReferenceType.Forward) {
    out.forwarded = true;
    out.forwarded_from = { channel_id: reference.channel_id, message_id: reference.message_id };
  } else if (reference?.message_id) {
    out.reply_to = reference.message_id;
  }
  if (message.thread?.id) out.thread_id = message.thread.id;

  if (body.attachments.length > 0) {
    out.attachments = body.attachments.map((a) => ({
      name: a.filename,
      url: a.url,
      size: a.size,
    }));
  }
  if (body.embeds.length > 0) out.embeds = body.embeds.map((e) => formatEmbed(e, detail));
  if (message.poll) out.poll = formatPoll(message.poll);
  if (message.reactions && message.reactions.length > 0) {
    out.reactions = message.reactions.map((r) => ({
      emoji: r.emoji.name ?? r.emoji.id ?? "?",
      count: r.count,
    }));
  }

  return out;
}

export interface CompactChannel {
  id: string;
  name: string;
  type: string;
  parent_id?: string;
  topic?: string;
  position?: number;
  nsfw?: boolean;
  slowmode_seconds?: number;
  archived?: boolean;
  locked?: boolean;
}

export function formatChannel(channel: APIChannel, detail: Detail = "compact"): CompactChannel {
  const out: CompactChannel = {
    id: channel.id,
    name: "name" in channel && channel.name ? channel.name : "(unnamed)",
    type: channelTypeName(channel.type),
  };

  if ("parent_id" in channel && channel.parent_id) out.parent_id = channel.parent_id;
  if ("topic" in channel && channel.topic) out.topic = clip(channel.topic, detail === "full" ? 1024 : 200);
  if ("nsfw" in channel && channel.nsfw) out.nsfw = true;
  if ("rate_limit_per_user" in channel && channel.rate_limit_per_user) {
    out.slowmode_seconds = channel.rate_limit_per_user;
  }
  if ("thread_metadata" in channel && channel.thread_metadata) {
    if (channel.thread_metadata.archived) out.archived = true;
    if (channel.thread_metadata.locked) out.locked = true;
  }
  if (detail === "full" && "position" in channel && typeof channel.position === "number") {
    out.position = channel.position;
  }

  return out;
}

export interface CompactRole {
  id: string;
  name: string;
  position: number;
  color?: string;
  hoisted?: boolean;
  mentionable?: boolean;
  managed?: boolean;
  permissions?: string[];
}

export function formatRole(role: APIRole, detail: Detail = "compact"): CompactRole {
  const out: CompactRole = { id: role.id, name: role.name, position: role.position };
  if (role.color !== 0) out.color = `#${role.color.toString(16).padStart(6, "0")}`;
  if (role.hoist) out.hoisted = true;
  if (role.mentionable) out.mentionable = true;
  if (role.managed) out.managed = true;
  if (detail === "full") out.permissions = permissionNames(role.permissions);
  return out;
}

export interface CompactMember {
  id: string;
  username: string;
  display_name: string;
  nickname?: string;
  bot?: boolean;
  joined_at?: string;
  roles: string[];
  timed_out_until?: string;
}

/**
 * `roleNames` maps role id -> name so the agent sees "Moderator" instead of a
 * snowflake. Falls back to raw ids when the map is not supplied.
 */
export function formatMember(
  member: APIGuildMember,
  roleNames?: ReadonlyMap<string, string>,
): CompactMember {
  const user = member.user;
  const out: CompactMember = {
    id: user.id,
    username: user.username,
    display_name: member.nick ?? user.global_name ?? user.username,
    roles: member.roles.map((id) => roleNames?.get(id) ?? id),
  };

  if (member.nick) out.nickname = member.nick;
  if (user.bot) out.bot = true;
  if (member.joined_at) out.joined_at = member.joined_at;
  if (member.communication_disabled_until) {
    const until = new Date(member.communication_disabled_until);
    if (until.getTime() > Date.now()) out.timed_out_until = member.communication_disabled_until;
  }

  return out;
}

export interface CompactGuild {
  id: string;
  name: string;
  description?: string;
  owner_id?: string;
  member_count?: number;
  created_at?: string;
  features?: string[];
}

export function formatGuild(guild: APIGuild, detail: Detail = "compact"): CompactGuild {
  const out: CompactGuild = { id: guild.id, name: guild.name };
  if (guild.description) out.description = guild.description;
  if (guild.owner_id) out.owner_id = guild.owner_id;

  if (typeof guild.approximate_member_count === "number") {
    out.member_count = guild.approximate_member_count;
  }

  if (detail === "full") {
    const created = snowflakeToDate(guild.id);
    if (created) out.created_at = created;
    if (guild.features.length > 0) out.features = [...guild.features];
  }

  return out;
}

/** Everything a text search should look at: the content plus embed text. */
export function searchableText(message: APIMessage): string {
  const body = bodyOf(message);
  if (body.embeds.length === 0) return body.content;
  const embedText = body.embeds
    .flatMap((e) => [e.title, e.description, ...(e.fields ?? []).flatMap((f) => [f.name, f.value])])
    .filter(Boolean)
    .join("\n");
  return `${body.content}\n${embedText}`;
}
