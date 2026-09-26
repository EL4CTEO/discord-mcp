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
const MENTION = /^<[@#][!&]?(\d{17,20})>$/;
const EVERYONE = /^@?everyone$/i;

/** Discord caps GET /users/@me/guilds at 200 per page. */
const GUILD_PAGE = 200;

/** True when the string is already a Discord ID and needs no lookup. */
export function isSnowflake(value: string): boolean {
  return SNOWFLAKE.test(value);
}

/**
 * Accepts every shape a human or model might type for an entity:
 * a raw ID, a mention (`<#123>`), or a decorated name (`#general`, `@Mods`).
 * Returns an ID directly when one is recognisable, otherwise the bare name.
 */
function parseRef(input: string): { id?: string; name: string } {
  const trimmed = input.trim();

  const mention = MENTION.exec(trimmed);
  if (mention?.[1]) return { id: mention[1], name: trimmed };
  if (SNOWFLAKE.test(trimmed)) return { id: trimmed, name: trimmed };

  return { name: trimmed.replace(/^[#@]/, "").trim() };
}

/** Case/format-insensitive comparison: "Breakout Block" == "breakout-block". */
function normalize(value: string): string {
  return value.toLowerCase().replace(/[\s_-]+/g, "");
}

interface Named {
  id: string;
  name: string;
  /** Extra detail shown only in ambiguity errors, e.g. a channel type. */
  detail?: string;
}

/**
 * Picks the single best match, or throws a message that lists the real options
 * so the agent can immediately retry with a valid value.
 */
function pickOne<T extends Named>(candidates: readonly T[], query: string, kind: string): T {
  const query_ = query.trim();
  const target = normalize(query_);

  // Tried in order of decreasing precision. The literal pass matters more than
  // it looks: Discord servers routinely hold a "general" text channel next to a
  // "General" voice channel, and those are indistinguishable once normalised.
  // Without this, the single most common channel name in Discord is unusable.
  const literal = candidates.filter((c) => c.name === query_);
  if (literal.length === 1) return literal[0] as T;

  const exact = candidates.filter((c) => normalize(c.name) === target);
  if (exact.length === 1) return exact[0] as T;

  const pool = exact.length > 1 ? exact : candidates.filter((c) => normalize(c.name).includes(target));

  if (pool.length === 1) return pool[0] as T;

  if (pool.length === 0) {
    const available = candidates.slice(0, 25).map((c) => c.name).join(", ");
    throw new ToolError(`No ${kind} named "${query}" was found.`, {
      code: "NOT_FOUND",
      hint: available ? `Available ${kind}s: ${available}` : `The bot can see no ${kind}s here.`,
    });
  }

  const names = pool
    .slice(0, 15)
    .map((c) => `${c.name} (${c.detail ? `${c.detail}, ` : ""}${c.id})`)
    .join(", ");
  throw new ToolError(`"${query}" matches ${pool.length} ${kind}s, so it is ambiguous.`, {
    code: "AMBIGUOUS",
    hint: `Pass the exact name or the ID. Matches: ${names}`,
  });
}

function namedChannels(channels: readonly APIChannel[]): Named[] {
  return channels.flatMap<Named>((c) =>
    "name" in c && c.name ? [{ id: c.id, name: c.name, detail: channelTypeName(c.type) }] : [],
  );
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
  // guild id + normalised name -> member id. Names rarely change.
  readonly #members = new TtlCache<string>(600_000, 5_000);
  // Channels never move between servers, so this map is never invalidated.
  readonly #channelGuild = new Map<string, string | null>();
  readonly #dmChannels = new Map<string, string>();

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
   * Active threads are not part of Discord's channel listing, so they are only
   * consulted when no channel matches - the common case pays nothing extra.
   */
  async channelId(input: string, guildId: string): Promise<string> {
    const ref = parseRef(input);
    if (ref.id) return ref.id;

    const channels = namedChannels(await this.channels(guildId));
    try {
      return pickOne(channels, ref.name, "channel").id;
    } catch (error) {
      if (!(error instanceof ToolError) || error.code !== "NOT_FOUND") throw error;

      const threads = namedChannels(await this.threads(guildId).catch(() => []));
      if (threads.length === 0) throw error;
      try {
        return pickOne(threads, ref.name, "thread").id;
      } catch (threadError) {
        if (threadError instanceof ToolError && threadError.code === "NOT_FOUND") throw error;
        throw threadError;
      }
    }
  }

  /** Resolves a role. `@everyone` maps to the guild's own ID, as Discord defines it. */
  async roleId(input: string, guildId: string): Promise<string> {
    if (EVERYONE.test(input.trim())) return guildId;

    const ref = parseRef(input);
    if (ref.id) return ref.id;

    const roles = await this.roles(guildId);
    return pickOne(roles.map((r) => ({ id: r.id, name: r.name })), ref.name, "role").id;
  }

  /**
   * Resolves a member by ID, username, nickname or display name.
   *
   * Uses Discord's member-search endpoint rather than listing every member,
   * so this stays fast on servers with tens of thousands of people and does
   * not require the privileged Server Members intent. Returns the member
   * object when the search produced one, so callers that need it can skip a
   * second fetch.
   */
  async member(input: string, guildId: string): Promise<{ id: string; member?: APIGuildMember }> {
    const ref = parseRef(input);
    if (ref.id) return { id: ref.id };

    const cacheKey = `${guildId}:${normalize(ref.name)}`;
    const cached = this.#members.get(cacheKey);
    if (cached) return { id: cached };

    const matches = await this.#rest.get<APIGuildMember[]>(Routes.guildMembersSearch(guildId), {
      query: ref.name,
      limit: 25,
    });

    const byId = new Map(matches.map((m) => [m.user.id, m]));
    const displayNames = matches.map<Named>((m) => ({
      id: m.user.id,
      name: m.nick ?? m.user.global_name ?? m.user.username,
    }));

    let id: string;
    // A nickname can differ from the username that was searched for, so try
    // usernames as a second pass before giving up.
    try {
      id = pickOne(displayNames, ref.name, "member").id;
    } catch (error) {
      const usernames = matches.map<Named>((m) => ({ id: m.user.id, name: m.user.username }));
      if (!usernames.some((m) => normalize(m.name) === normalize(ref.name))) {
        if (error instanceof ToolError && error.code === "NOT_FOUND") {
          throw new ToolError(`No member named "${ref.name}" was found.`, {
            code: "NOT_FOUND",
            hint:
              "Search matches the start of a username or nickname. Try discord_list_members with a shorter " +
              "query, or pass the user ID.",
          });
        }
        throw error;
      }
      id = pickOne(usernames, ref.name, "member").id;
    }

    this.#members.set(cacheKey, id);
    const member = byId.get(id);
    return member ? { id, member } : { id };
  }

  async memberId(input: string, guildId: string): Promise<string> {
    return (await this.member(input, guildId)).id;
  }

  /** The DM channel with a user, opened once and remembered. */
  async dmChannel(userId: string): Promise<string> {
    const known = this.#dmChannels.get(userId);
    if (known) return known;

    const channel = await this.#rest.post<APIChannel>(Routes.userChannels(), { recipient_id: userId });
    this.#dmChannels.set(userId, channel.id);
    this.#channelGuild.set(channel.id, null);
    return channel.id;
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
      case "THREAD_DELETE":
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
