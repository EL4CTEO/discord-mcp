import { Routes } from "discord-api-types/v10";
import type {
  APIChannel,
  APIEmoji,
  APIGuild,
  APIGuildMember,
  APIRole,
  APIThreadChannel,
  APIUser,
  GatewayDispatchPayload,
} from "discord-api-types/v10";
import type { Config } from "../config.js";
import { ToolError } from "../lib/errors.js";
import { channelTypeName } from "../lib/format.js";
import { TtlCache } from "./cache.js";
import type { DiscordRest } from "./rest.js";

const SNOWFLAKE = /^\d{17,20}$/;
/** Captures the sigil (@ or #), the optional modifier (! for nick mentions, & for roles) and the ID. */
const MENTION = /^<([@#])(!|&)?(\d{17,20})>$/;
const EVERYONE = /^@?everyone$/i;

/** Discord caps GET /users/@me/guilds at 200 per page. */
const GUILD_PAGE = 200;
/**
 * Discord allows up to 1000 results from member search. 100 keeps responses
 * small while still being large enough that a full page is a useful signal.
 */
const MEMBER_SEARCH_LIMIT = 100;

const UINT64_LIMIT = 2n ** 64n;

/** True when the string is already a Discord ID and needs no lookup. */
export function isSnowflake(value: string): boolean {
  // Snowflakes are unsigned 64-bit integers, so a 20-digit string can still be out of range.
  return SNOWFLAKE.test(value) && BigInt(value) < UINT64_LIMIT;
}

/** What a mention refers to, so a tool can refuse a mention of the wrong kind. */
type MentionKind = "user" | "role" | "channel";

interface ParsedRef {
  id?: string;
  name: string;
  mention?: MentionKind;
}

/**
 * Accepts every shape a human or model might type for an entity:
 * a raw ID, a mention (`<#123>`), or a decorated name (`#general`, `@Mods`).
 * Returns an ID directly when one is recognisable, otherwise the bare name.
 */
function parseRef(input: string): ParsedRef {
  const trimmed = input.trim();

  const mention = MENTION.exec(trimmed);
  if (mention) {
    const [, sigil, modifier, id] = mention;
    if (id && isSnowflake(id)) {
      const kind: MentionKind = sigil === "#" ? "channel" : modifier === "&" ? "role" : "user";
      return { id, name: trimmed, mention: kind };
    }
  }
  if (isSnowflake(trimmed)) return { id: trimmed, name: trimmed };

  return { name: trimmed.replace(/^[#@]/, "").trim() };
}

/** Case/format-insensitive comparison: "Breakout Block" == "breakout-block". */
function normalize(value: string): string {
  return value.toLowerCase().replace(/[\s_-]+/g, "");
}

/** Options for lookups that feed destructive actions. */
export interface MatchOptions {
  /**
   * Refuse substring matches. A near miss must never pick the target of a ban,
   * delete or role removal, so only the literal or normalised name counts.
   */
  exact?: boolean;
}

interface Named {
  id: string;
  name: string;
  /** Extra detail shown only in ambiguity errors, e.g. a channel type. */
  detail?: string;
}

function isNotFound(error: unknown): boolean {
  return error instanceof ToolError && error.code === "NOT_FOUND";
}

function notFound(candidates: readonly Named[], query: string, kind: string, exact: boolean): ToolError {
  const available = candidates.slice(0, 25).map((c) => c.name).join(", ");
  const list = available ? `Available ${kind}s: ${available}` : `The bot can see no ${kind}s here.`;
  return new ToolError(`No ${kind} named "${query}" was found.`, {
    code: "NOT_FOUND",
    hint: exact ? `Destructive actions need the exact name or the ID. ${list}` : list,
  });
}

function ambiguous(query: string, kind: string, pool: readonly Named[]): ToolError {
  const names = pool
    .slice(0, 15)
    .map((c) => `${c.name} (${c.detail ? `${c.detail}, ` : ""}${c.id})`)
    .join(", ");
  return new ToolError(`"${query}" matches ${pool.length} ${kind}s, so it is ambiguous.`, {
    code: "AMBIGUOUS",
    hint: `Pass the exact name or the ID. Matches: ${names}`,
  });
}

/**
 * Picks the single best match, or throws a message that lists the real options
 * so the agent can immediately retry with a valid value.
 *
 * With `exact`, the substring pass is skipped entirely: only the literal or
 * normalised name can select a candidate.
 */
function pickOne<T extends Named>(candidates: readonly T[], query: string, kind: string, exact = false): T {
  const query_ = query.trim();
  const target = normalize(query_);

  // An empty name ("#" or "@" alone) would match everything through includes().
  if (target === "") throw notFound(candidates, query, kind, exact);

  // Tried in order of decreasing precision. The literal pass matters more than
  // it looks: Discord servers routinely hold a "general" text channel next to a
  // "General" voice channel, and those are indistinguishable once normalised.
  // Without this, the single most common channel name in Discord is unusable.
  const literal = candidates.filter((c) => c.name === query_);
  if (literal.length === 1) return literal[0] as T;

  const exactPool = candidates.filter((c) => normalize(c.name) === target);
  if (exactPool.length === 1) return exactPool[0] as T;

  let pool: readonly T[] = exactPool;
  if (exactPool.length === 0 && !exact) {
    pool = candidates.filter((c) => normalize(c.name).includes(target));
  }

  if (pool.length === 1) return pool[0] as T;
  if (pool.length === 0) throw notFound(candidates, query, kind, exact);
  throw ambiguous(query, kind, pool);
}

function namedChannels(channels: readonly APIChannel[]): Named[] {
  return channels.flatMap<Named>((c) =>
    "name" in c && c.name ? [{ id: c.id, name: c.name, detail: channelTypeName(c.type) }] : [],
  );
}

/** A member as a pick candidate, showing the username when the name is something else. */
function memberNamed(member: APIGuildMember, name: string): Named {
  const detail = name === member.user.username ? undefined : `@${member.user.username}`;
  return { id: member.user.id, name, detail };
}

/**
 * Turns human-friendly references into Discord IDs.
 *
 * Every tool takes names or IDs interchangeably, which means the agent never
 * has to run a lookup tool first just to obtain a snowflake. Listings are
 * cached, and kept current in place: tools fold their own creates, edits and
 * deletes into the cache, and while the gateway is open its channel and role
 * events do the same, so a multi-step workflow never pays for a refetch.
 */
export class Resolver {
  readonly #rest: DiscordRest;
  readonly #config: Config;
  // Five minutes rather than seconds: every change made through this server is
  // written straight into the cache, so staleness can only come from a change
  // made outside it, which a short TTL would not reliably catch anyway.
  readonly #guilds = new TtlCache<APIGuild[]>(300_000, 4);
  readonly #channels = new TtlCache<APIChannel[]>(300_000, 32);
  readonly #roles = new TtlCache<APIRole[]>(300_000, 32);
  readonly #emojis = new TtlCache<APIEmoji[]>(300_000, 32);
  // Active threads come and go quickly, so they get a much shorter life.
  readonly #threads = new TtlCache<APIThreadChannel[]>(30_000, 32);
  // Channels never move between servers, so this map is never invalidated.
  readonly #channelGuild = new Map<string, string | null>();
  // Holds the in-flight promise too, so concurrent DMs to one user open a single channel.
  readonly #dmChannels = new Map<string, Promise<string>>();

  #self: Promise<APIUser> | undefined;

  constructor(rest: DiscordRest, config: Config) {
    this.#rest = rest;
    this.#config = config;
  }

  /** The bot's own user, cached for the process lifetime once it succeeds. */
  async self(): Promise<APIUser> {
    this.#self ??= this.#rest.get<APIUser>(Routes.user("@me")).catch((error: unknown) => {
      // Do not pin a transient failure (network blip, timeout) forever.
      this.#self = undefined;
      throw error;
    });
    return this.#self;
  }

  async selfId(): Promise<string> {
    return (await this.self()).id;
  }

  /** Every guild the bot is a member of, following pagination past 200. */
  async guilds(): Promise<APIGuild[]> {
    return this.#guilds.fetch("all", async () => {
      const all: APIGuild[] = [];
      let after: string | undefined;

      for (;;) {
        const page = await this.#rest.get<APIGuild[]>(Routes.userGuilds(), {
          limit: GUILD_PAGE,
          with_counts: true,
          after,
        });
        all.push(...page);
        if (page.length < GUILD_PAGE) return all;
        after = page[page.length - 1]?.id;
      }
    });
  }

  async channels(guildId: string): Promise<APIChannel[]> {
    return this.#channels.fetch(guildId, async () => {
      const channels = await this.#rest.get<APIChannel[]>(Routes.guildChannels(guildId));
      for (const channel of channels) this.#channelGuild.set(channel.id, guildId);
      return channels;
    });
  }

  async roles(guildId: string): Promise<APIRole[]> {
    return this.#roles.fetch(guildId, () => this.#rest.get<APIRole[]>(Routes.guildRoles(guildId)));
  }

  async emojis(guildId: string): Promise<APIEmoji[]> {
    return this.#emojis.fetch(guildId, () => this.#rest.get<APIEmoji[]>(Routes.guildEmojis(guildId)));
  }

  /** Active threads in a guild. Not part of the channel listing, so fetched separately. */
  async threads(guildId: string): Promise<APIThreadChannel[]> {
    return this.#threads.fetch(guildId, async () => {
      const active = await this.#rest.get<{ threads: APIThreadChannel[] }>(Routes.guildActiveThreads(guildId));
      for (const thread of active.threads) this.#channelGuild.set(thread.id, guildId);
      return active.threads;
    });
  }

  /** role id -> role name, so member listings show names instead of snowflakes. */
  async roleNames(guildId: string): Promise<Map<string, string>> {
    const roles = await this.roles(guildId);
    return new Map(roles.map((role) => [role.id, role.name]));
  }

  /** A channel from the cached listing, or undefined if it is not a top-level channel. */
  async findChannel(guildId: string, channelId: string): Promise<APIChannel | undefined> {
    return (await this.channels(guildId)).find((c) => c.id === channelId);
  }

  /**
   * Resolves the target server. Falls back to DISCORD_DEFAULT_GUILD, and then
   * to the only server the bot is in - the common single-server setup, where
   * making every call pass `guild` would be pure friction.
   */
  async guildId(input?: string): Promise<string> {
    const value = input ?? this.#config.defaultGuild;

    if (value) {
      const ref = parseRef(value);
      if (ref.id) return ref.id;
      return pickOne(await this.guilds(), ref.name, "server").id;
    }

    const guilds = await this.guilds();
    if (guilds.length === 1) return (guilds[0] as APIGuild).id;

    if (guilds.length === 0) {
      throw new ToolError("The bot is not in any server yet.", {
        code: "NO_GUILDS",
        hint: "Invite it with the OAuth2 URL from the Discord Developer Portal (scopes: bot, applications.commands).",
      });
    }

    throw new ToolError("The bot is in several servers, so `guild` is required.", {
      code: "GUILD_REQUIRED",
      hint: `Pass guild as a name or ID. Options: ${guilds.map((g) => g.name).join(", ")}`,
    });
  }

  /**
   * The server a channel ID belongs to, or null for a DM.
   *
   * Lets a call that names a channel by ID skip `guild` even when the bot is
   * in several servers - the ID already says where it lives.
   */
  async channelGuildId(channelId: string): Promise<string | null> {
    const known = this.#channelGuild.get(channelId);
    if (known !== undefined) return known;

    const channel = await this.#rest.get<APIChannel>(Routes.channel(channelId));
    const guildId = "guild_id" in channel && channel.guild_id ? channel.guild_id : null;
    this.#channelGuild.set(channelId, guildId);
    return guildId;
  }

  /**
   * Resolves a channel or thread within a guild.
   *
   * Active threads are not part of Discord's channel listing. They are only
   * fetched when no channel matches exactly, so the common case pays nothing
   * extra; when they are fetched, they compete with channels in one pick, so
   * a thread named exactly "bug-report" beats a channel "bug-report-archive".
   */
  async channelId(input: string, guildId: string, options: MatchOptions = {}): Promise<string> {
    const ref = parseRef(input);
    if (ref.mention && ref.mention !== "channel") {
      throw new ToolError(`That is a ${ref.mention} mention, not a channel.`, {
        code: "INVALID_ARGS",
        hint: "Pass a channel name, #name, or the channel ID.",
      });
    }
    if (ref.id) {
      // Only a channel already known to live elsewhere is refused. An unknown ID
      // costs no request to check, and Discord will reject a truly bad one anyway.
      const known = this.#channelGuild.get(ref.id);
      if (typeof known === "string" && known !== guildId) {
        throw new ToolError("That channel belongs to a different server.", {
          code: "WRONG_GUILD",
          hint: "Pass the server that contains this channel, or omit guild.",
        });
      }
      return ref.id;
    }

    const channels = namedChannels(await this.channels(guildId));
    const hasExact = channels.some((c) => c.name === ref.name || normalize(c.name) === normalize(ref.name));
    if (hasExact) return pickOne(channels, ref.name, "channel", options.exact).id;

    // A thread listing failure should not hide the channels that were found.
    const threads = namedChannels(await this.threads(guildId).catch(() => []));
    return pickOne([...channels, ...threads], ref.name, "channel", options.exact).id;
  }

  /** Resolves a role. `@everyone` maps to the guild's own ID, as Discord defines it. */
  async roleId(input: string, guildId: string, options: MatchOptions = {}): Promise<string> {
    if (EVERYONE.test(input.trim())) return guildId;

    const ref = parseRef(input);
    if (ref.mention && ref.mention !== "role") {
      throw new ToolError(`That is a ${ref.mention} mention, not a role.`, {
        code: "INVALID_ARGS",
        hint: "Pass a role name, @role, or the role ID.",
      });
    }
    if (ref.id) return ref.id;

    const roles = await this.roles(guildId);
    return pickOne(roles.map((r) => ({ id: r.id, name: r.name })), ref.name, "role", options.exact).id;
  }

  /**
   * Resolves a member by ID, username, nickname or display name.
   *
   * Uses Discord's member-search endpoint rather than listing every member,
   * so this stays fast on servers with tens of thousands of people and does
   * not require the privileged Server Members intent. Returns the member
   * object when the search produced one, so callers that need it can skip a
   * second fetch.
   *
   * Names are deliberately not cached. A nickname can change at any time, and
   * a stale name -> ID entry could make a ban or a role change hit the wrong
   * person. The search is a single cheap request, and Discord itself
   * de-duplicates identical searches that are in flight at the same moment.
   */
  async member(
    input: string,
    guildId: string,
    options: MatchOptions = {},
  ): Promise<{ id: string; member?: APIGuildMember }> {
    const ref = parseRef(input);
    if (ref.mention && ref.mention !== "user") {
      throw new ToolError("That is a role/channel mention, not a member.", {
        code: "INVALID_ARGS",
        hint: "Pass a member name, @name, or the user ID.",
      });
    }
    if (ref.id) return { id: ref.id };

    const query = ref.name;
    const target = normalize(query);
    if (target === "") {
      throw new ToolError(`No member named "${input.trim()}" was found.`, {
        code: "NOT_FOUND",
        hint: "Pass a name or the user ID.",
      });
    }

    const matches = await this.#rest.get<APIGuildMember[]>(Routes.guildMembersSearch(guildId), {
      query,
      limit: MEMBER_SEARCH_LIMIT,
    });
    const byId = new Map(matches.map((m) => [m.user.id, m]));
    const found = (id: string): { id: string; member?: APIGuildMember } => {
      const member = byId.get(id);
      return member ? { id, member } : { id };
    };

    // An exact name on any of the three fields beats a partial hit on someone
    // else, so "bob" finds the user named bob even if another member's nickname is "Bobby".
    const exactHits = matches.filter((m) =>
      [m.user.username, m.user.global_name, m.nick].some((n) => n != null && normalize(n) === target),
    );
    if (exactHits.length === 1 && exactHits[0]) return found(exactHits[0].user.id);
    if (exactHits.length > 1) {
      throw ambiguous(
        query,
        "member",
        exactHits.map((m) => memberNamed(m, m.nick ?? m.user.global_name ?? m.user.username)),
      );
    }

    // A full page means the real set may hold the exact name too, so a partial
    // pick would be a guess.
    if (matches.length >= MEMBER_SEARCH_LIMIT) {
      throw new ToolError(`"${query}" matches too many members to choose one.`, {
        code: "AMBIGUOUS",
        hint: "Too many members match; type more of the name or pass the ID.",
      });
    }

    if (options.exact) {
      throw new ToolError(`No member named "${query}" was found.`, {
        code: "NOT_FOUND",
        hint: "Destructive actions need the exact name or the ID.",
      });
    }

    // Search matches the start of a name, so a partial pick is only a fallback.
    const displayNames = matches.map((m) => memberNamed(m, m.nick ?? m.user.global_name ?? m.user.username));
    try {
      return found(pickOne(displayNames, query, "member").id);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }

    // A nickname can hide the username that was searched for.
    const usernames = matches.map((m) => memberNamed(m, m.user.username));
    try {
      return found(pickOne(usernames, query, "member").id);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      throw new ToolError(`No member named "${query}" was found.`, {
        code: "NOT_FOUND",
        hint:
          "Search matches the start of a username or nickname. Try discord_list_members with a shorter " +
          "query, or pass the user ID.",
      });
    }
  }

  async memberId(input: string, guildId: string, options: MatchOptions = {}): Promise<string> {
    return (await this.member(input, guildId, options)).id;
  }

  /** The DM channel with a user, opened once and remembered. */
  async dmChannel(userId: string): Promise<string> {
    let pending = this.#dmChannels.get(userId);
    if (!pending) {
      const opened = this.#rest.post<APIChannel>(Routes.userChannels(), { recipient_id: userId }).then((channel) => {
        this.#channelGuild.set(channel.id, null);
        return channel.id;
      });
      // Forget a failed attempt, so a transient error is not pinned for the process lifetime.
      opened.catch(() => {
        if (this.#dmChannels.get(userId) === opened) this.#dmChannels.delete(userId);
      });
      this.#dmChannels.set(userId, opened);
      pending = opened;
    }
    return pending;
  }

  /**
   * Pre-loads the listings the first tool call would otherwise block on.
   *
   * Fire-and-forget: failures are ignored because this is only an optimisation,
   * and a bad token must surface through a real tool call with a real error
   * message rather than as a startup crash.
   */
  async warm(): Promise<void> {
    try {
      const [guildId] = await Promise.all([this.guildId(), this.self()]);
      await Promise.all([this.channels(guildId), this.roles(guildId)]);
    } catch {
      // Ambiguous or unreachable - the first real call will report it properly.
    }
  }

  // --- Cache maintenance --------------------------------------------------

  upsertChannel(guildId: string, channel: APIChannel): void {
    this.#channelGuild.set(channel.id, guildId);
    this.#channels.update(guildId, (list) => upsert(list, channel));
  }

  removeChannel(guildId: string, channelId: string): void {
    this.#channels.update(guildId, (list) => list.filter((c) => c.id !== channelId));
    this.#threads.update(guildId, (list) => list.filter((c) => c.id !== channelId));
  }

  upsertRole(guildId: string, role: APIRole): void {
    this.#roles.update(guildId, (list) => upsert(list, role));
  }

  removeRole(guildId: string, roleId: string): void {
    this.#roles.update(guildId, (list) => list.filter((r) => r.id !== roleId));
  }

  /** Replaces the whole role listing, e.g. with the result of a reorder. */
  setRoles(guildId: string, roles: APIRole[]): void {
    this.#roles.set(guildId, roles);
  }

  /** Drops a guild's channel listing when a change cannot be folded in (reorders). */
  invalidateChannels(guildId: string): void {
    this.#channels.delete(guildId);
    this.#threads.delete(guildId);
  }

  /** Drops a guild's active-thread listing after a thread is created or changes state. */
  invalidateThreads(guildId: string): void {
    this.#threads.delete(guildId);
  }

  /** Drops every cached listing for a guild. */
  invalidate(guildId: string): void {
    this.#channels.delete(guildId);
    this.#roles.delete(guildId);
    this.#threads.delete(guildId);
    this.#emojis.delete(guildId);
  }

  /**
   * Keeps the caches current from live gateway traffic while it is connected,
   * including changes made in the Discord client by people.
   */
  applyDispatch(payload: GatewayDispatchPayload): void {
    switch (payload.t) {
      case "GUILD_CREATE": {
        // A newly joined server is missing from the cached guild list until it is refetched.
        this.#guilds.clear();
        const guild = payload.d;
        if ("unavailable" in guild && guild.unavailable) return;
        if ("channels" in guild && Array.isArray(guild.channels)) {
          for (const channel of guild.channels) this.#channelGuild.set(channel.id, guild.id);
          this.#channels.set(guild.id, guild.channels);
        }
        if ("roles" in guild && Array.isArray(guild.roles)) this.#roles.set(guild.id, guild.roles);
        return;
      }
      case "GUILD_DELETE":
        this.#guilds.clear();
        this.invalidate(payload.d.id);
        return;
      case "GUILD_UPDATE":
        this.#guilds.clear();
        return;
      case "CHANNEL_CREATE":
      case "CHANNEL_UPDATE": {
        const channel = payload.d;
        if ("guild_id" in channel && channel.guild_id) this.upsertChannel(channel.guild_id, channel);
        return;
      }
      case "CHANNEL_DELETE": {
        const channel = payload.d;
        if ("guild_id" in channel && channel.guild_id) this.removeChannel(channel.guild_id, channel.id);
        return;
      }
      case "THREAD_CREATE":
      case "THREAD_UPDATE":
      case "THREAD_DELETE":
      case "THREAD_LIST_SYNC":
        // Threads also change state (archive, lock, rename) without a create or delete,
        // and a list sync replaces the set entirely, so every thread event drops the listing.
        if (payload.d.guild_id) this.#threads.delete(payload.d.guild_id);
        return;
      case "GUILD_ROLE_CREATE":
      case "GUILD_ROLE_UPDATE":
        this.upsertRole(payload.d.guild_id, payload.d.role);
        return;
      case "GUILD_ROLE_DELETE":
        this.removeRole(payload.d.guild_id, payload.d.role_id);
        return;
      case "GUILD_EMOJIS_UPDATE":
        this.#emojis.set(payload.d.guild_id, payload.d.emojis);
        return;
      default:
        return;
    }
  }
}

/** Returns a new list with `item` replacing the entry of the same id, or appended. */
function upsert<T extends { id: string }>(list: readonly T[], item: T): T[] {
  const index = list.findIndex((entry) => entry.id === item.id);
  if (index === -1) return [...list, item];
  const next = [...list];
  next[index] = item;
  return next;
}
