import { CompressionMethod, WebSocketManager, WebSocketShardEvents } from "@discordjs/ws";
import { GatewayIntentBits } from "discord-api-types/v10";
import type { GatewayDispatchPayload } from "discord-api-types/v10";
import type { Config } from "../config.js";
import { ToolError } from "../lib/errors.js";
import type { DiscordRest } from "./rest.js";

/** Gateway dispatches an agent can usefully wait for or review. */
export const EVENT_TYPES = [
  "MESSAGE_CREATE",
  "MESSAGE_UPDATE",
  "MESSAGE_DELETE",
  "MESSAGE_DELETE_BULK",
  "MESSAGE_REACTION_ADD",
  "MESSAGE_REACTION_REMOVE",
  "GUILD_MEMBER_ADD",
  "GUILD_MEMBER_REMOVE",
  "GUILD_MEMBER_UPDATE",
  "GUILD_BAN_ADD",
  "GUILD_BAN_REMOVE",
  "GUILD_ROLE_CREATE",
  "GUILD_ROLE_UPDATE",
  "GUILD_ROLE_DELETE",
  "CHANNEL_CREATE",
  "CHANNEL_UPDATE",
  "CHANNEL_DELETE",
  "THREAD_CREATE",
  "THREAD_UPDATE",
  "THREAD_DELETE",
  "VOICE_STATE_UPDATE",
  "INVITE_CREATE",
  "INVITE_DELETE",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/**
 * Only these are kept in the buffer. Everything else - READY, GUILD_CREATE
 * with its full member and channel payload, presence churn - would evict the
 * events an agent cares about while telling it nothing.
 */
const BUFFERED = new Set<string>(EVENT_TYPES);

/** One received gateway dispatch, trimmed to what an agent can act on. */
export interface BufferedEvent {
  seq: number;
  type: string;
  at: string;
  guild_id?: string;
  channel_id?: string;
  message_id?: string;
  user?: string;
  user_id?: string;
  summary: string;
  /** Full message text for message events; used for matching, never clipped. */
  content?: string;
  data: unknown;
}

/** Intents that any bot may use without portal configuration. */
const BASE_INTENTS =
  GatewayIntentBits.Guilds |
  GatewayIntentBits.GuildMessages |
  GatewayIntentBits.GuildMessageReactions |
  GatewayIntentBits.GuildModeration |
  GatewayIntentBits.GuildVoiceStates |
  GatewayIntentBits.GuildInvites |
  GatewayIntentBits.GuildExpressions |
  GatewayIntentBits.DirectMessages |
  GatewayIntentBits.DirectMessageReactions;

/** Intents that must be switched on in the Developer Portal first. */
const PRIVILEGED_INTENTS = GatewayIntentBits.MessageContent | GatewayIntentBits.GuildMembers;

/** Close codes after which reconnecting cannot succeed, with what to do about each. */
const FATAL_CLOSE: Readonly<Record<number, { message: string; hint: string }>> = {
  4004: {
    message: "Discord rejected the bot token.",
    hint: "Reset the token in the Developer Portal and update DISCORD_TOKEN.",
  },
  4013: {
    message: "Discord rejected the gateway intents as invalid.",
    hint: "This is a bug in discord-mcp; please report it.",
  },
  4014: {
    message: "Discord refused the requested privileged gateway intents.",
    hint:
      "Open the Developer Portal -> your app -> Bot and enable MESSAGE CONTENT INTENT and " +
      "SERVER MEMBERS INTENT, or set DISCORD_PRIVILEGED_INTENTS=false to listen without them.",
  },
};

type DispatchListener = (payload: GatewayDispatchPayload) => void;

/**
 * Lazily-connected gateway listener.
 *
 * Most Discord work is plain REST, and opening a WebSocket costs 2-5 seconds of
 * identify/ready handshake. Paying that on every MCP server start would slow
 * down every unrelated tool call, so the socket is opened only when an
 * event-shaped tool actually needs it, and is dropped again after an idle
 * period. Received dispatches land in a bounded ring buffer so a tool can ask
 * "what happened while you were listening?" without holding the call open.
 */
export class GatewayBridge {
  readonly #config: Config;
  readonly #rest: DiscordRest;
  readonly #buffer: BufferedEvent[] = [];
  readonly #waiters = new Set<(event: BufferedEvent) => void>();
  readonly #listeners = new Set<DispatchListener>();

  #manager: WebSocketManager | undefined;
  #connecting: Promise<void> | undefined;
  #idleTimer: NodeJS.Timeout | undefined;
  #seq = 0;
  #startedAt: string | undefined;

  constructor(rest: DiscordRest, config: Config) {
    this.#rest = rest;
    this.#config = config;
  }

  get isConnected(): boolean {
    return this.#manager !== undefined && this.#connecting === undefined;
  }

  get listeningSince(): string | undefined {
    return this.#startedAt;
  }

  /** Sequence number of the newest buffered event; 0 when nothing arrived yet. */
  get lastSeq(): number {
    return this.#seq;
  }

  /** Receives every raw dispatch, buffered or not. Used to keep caches current. */
  onDispatch(listener: DispatchListener): void {
    this.#listeners.add(listener);
  }

  /**
   * Opens the socket if needed and refreshes the idle countdown.
   * Concurrent callers share one in-flight connection attempt.
   */
  async ensureConnected(): Promise<void> {
    this.#touch();
    if (this.#manager && !this.#connecting) return;
    this.#connecting ??= this.#connect().finally(() => {
      this.#connecting = undefined;
    });
    await this.#connecting;
  }

  async #connect(): Promise<void> {
    const intents = this.#config.privilegedIntents ? BASE_INTENTS | PRIVILEGED_INTENTS : BASE_INTENTS;

    const manager = new WebSocketManager({
      token: this.#config.token,
      intents,
      rest: this.#rest.raw,
      // node:zlib transport compression: no native addon needed, and it cuts
      // gateway bandwidth several-fold on busy servers.
      compression: CompressionMethod.ZlibNative,
      initialPresence: null,
    });

    manager.on(WebSocketShardEvents.Dispatch, (payload) => this.ingest(payload));

    // After a fatal close the library stops reconnecting, so forget the
    // manager: the next call reconnects and reports the real problem, instead
    // of waiting forever on a dead socket.
    manager.on(WebSocketShardEvents.Closed, (code) => {
      if (FATAL_CLOSE[code] && this.#manager === manager && !this.#connecting) void this.disconnect();
    });

    this.#manager = manager;

    try {
      await this.#awaitReady(manager);
      this.#startedAt = new Date().toISOString();
    } catch (error) {
      if (this.#manager === manager) this.#manager = undefined;
      await Promise.resolve(manager.destroy()).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Resolves once the shard is READY; rejects on timeout or a fatal close.
   *
   * connect() alone would wait forever on a rejected token, so it is raced
   * against both. The timer is always cleared, so a failed connect can never
   * leave a stray rejection behind to crash the process later.
   */
  #awaitReady(manager: WebSocketManager): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onClosed = (code: number): void => {
        const fatal = FATAL_CLOSE[code];
        if (fatal) settle(new ToolError(fatal.message, { code, hint: fatal.hint }));
      };

      const timer = setTimeout(() => {
        settle(
          new ToolError("Timed out connecting to the Discord gateway.", {
            code: "GATEWAY_TIMEOUT",
            hint: "Check network access to gateway.discord.gg and that DISCORD_TOKEN is valid.",
          }),
        );
      }, this.#config.requestTimeoutMs * 2);

      let settled = false;
      const settle = (error?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        manager.off(WebSocketShardEvents.Closed, onClosed);
        if (error === undefined) resolve();
        else reject(error);
      };

      manager.on(WebSocketShardEvents.Closed, onClosed);
      manager.connect().then(
        () => settle(),
        (error: unknown) => settle(error ?? new Error("Gateway connection failed")),
      );
    });
  }

  /** Feeds one dispatch through cache listeners and the event buffer. Public for tests. */
  ingest(payload: GatewayDispatchPayload): void {
    for (const listener of this.#listeners) {
      try {
        listener(payload);
      } catch {
        // A cache-maintenance bug must never take the event stream down.
      }
    }
    if (BUFFERED.has(payload.t)) this.#record(payload);
  }

  /** Normalises a dispatch, appends it to the ring buffer, wakes waiters. */
  #record(payload: GatewayDispatchPayload): void {
    const data = (payload.d ?? {}) as Record<string, unknown>;
    const event: BufferedEvent = {
      seq: ++this.#seq,
      type: payload.t,
      at: new Date().toISOString(),
      summary: summarize(payload.t, data),
      data: payload.d,
    };

    const guildId = data["guild_id"];
    if (typeof guildId === "string") event.guild_id = guildId;

    const channelId = data["channel_id"];
    if (typeof channelId === "string") event.channel_id = channelId;
    else if (payload.t.startsWith("THREAD_") || payload.t.startsWith("CHANNEL_")) {
      if (typeof data["id"] === "string") event.channel_id = data["id"];
    }

    const messageId = payload.t.startsWith("MESSAGE_") ? (data["message_id"] ?? data["id"]) : undefined;
    if (typeof messageId === "string") event.message_id = messageId;

    const user = actor(data);
    if (user) {
      event.user = user.name;
      event.user_id = user.id;
    } else if (typeof data["user_id"] === "string") {
      event.user_id = data["user_id"];
    }

    if (typeof data["content"] === "string") event.content = data["content"];

    this.#buffer.push(event);
    if (this.#buffer.length > this.#config.eventBufferSize) this.#buffer.shift();

    for (const waiter of this.#waiters) waiter(event);
  }

  /** Buffered events, newest last, optionally filtered. */
  recent(options: { match?: (event: BufferedEvent) => boolean; afterSeq?: number; limit: number }): BufferedEvent[] {
    const { match, afterSeq = 0, limit } = options;
    const matched = this.#buffer.filter((e) => e.seq > afterSeq && (!match || match(e)));
    return matched.slice(-limit);
  }

  /**
   * Resolves with the first event matching `predicate`, or undefined on
   * timeout or cancellation.
   *
   * With `afterSeq`, events already buffered past that point are checked
   * first - so an agent that read the buffer and then decided to wait cannot
   * miss something that arrived in between.
   */
  async waitFor(
    predicate: (event: BufferedEvent) => boolean,
    timeoutMs: number,
    options: { afterSeq?: number; signal?: AbortSignal } = {},
  ): Promise<BufferedEvent | undefined> {
    // Anything arriving while the connection is awaited counts too, so the
    // default starting point is "now", taken before the first await.
    const since = options.afterSeq ?? this.#seq;
    await this.ensureConnected();

    const early = this.#buffer.find((e) => e.seq > since && predicate(e));
    if (early) return early;

    if (options.signal?.aborted) return undefined;

    return new Promise<BufferedEvent | undefined>((resolve) => {
      const done = (value: BufferedEvent | undefined): void => {
        clearTimeout(timer);
        this.#waiters.delete(listener);
        options.signal?.removeEventListener("abort", onAbort);
        this.#touch();
        resolve(value);
      };

      const listener = (event: BufferedEvent): void => {
        if (predicate(event)) done(event);
      };
      const onAbort = (): void => done(undefined);

      const timer = setTimeout(() => done(undefined), timeoutMs);
      this.#waiters.add(listener);
      options.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * Restarts the idle countdown that eventually drops the socket.
   *
   * The countdown never fires while a wait is in progress: a five-minute wait
   * must not lose its socket to a two-minute idle timeout halfway through.
   */
  #touch(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => {
      if (this.#waiters.size > 0) this.#touch();
      else void this.disconnect();
    }, this.#config.gatewayIdleMs);
    this.#idleTimer.unref();
  }

  async disconnect(): Promise<void> {
    if (this.#idleTimer) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = undefined;
    }

    const manager = this.#manager;
    this.#manager = undefined;
    this.#startedAt = undefined;
    if (manager) await Promise.resolve(manager.destroy()).catch(() => undefined);
  }
}

/** Who caused an event, from whichever field that dispatch uses. */
function actor(data: Record<string, unknown>): { id: string; name: string } | undefined {
  const member = data["member"] as { user?: unknown } | undefined;
  const candidate = data["author"] ?? data["user"] ?? member?.user;
  if (!candidate || typeof candidate !== "object") return undefined;

  const user = candidate as { id?: unknown; username?: unknown; global_name?: unknown };
  if (typeof user.id !== "string" || typeof user.username !== "string") return undefined;
  return { id: user.id, name: user.username };
}

/** One-line, human-readable description of a dispatch. */
function summarize(type: string, d: Record<string, unknown>): string {
  const username = (key: string, fallback: string): string =>
    (d[key] as { username?: string } | undefined)?.username ?? fallback;

  switch (type) {
    case "MESSAGE_CREATE":
    case "MESSAGE_UPDATE": {
      const content = typeof d["content"] === "string" ? d["content"] : "";
      const text = content.length > 160 ? `${content.slice(0, 159)}…` : content;
      return `${username("author", "someone")}: ${text || "(no text content)"}`;
    }
    case "MESSAGE_DELETE":
      return `message ${String(d["id"])} deleted`;
    case "MESSAGE_DELETE_BULK":
      return `${Array.isArray(d["ids"]) ? d["ids"].length : "several"} messages bulk-deleted`;
    case "MESSAGE_REACTION_ADD":
    case "MESSAGE_REACTION_REMOVE": {
      const emoji = d["emoji"] as { name?: string } | undefined;
      const who = (d["member"] as { user?: { username?: string } } | undefined)?.user?.username;
      const verb = type === "MESSAGE_REACTION_ADD" ? "added" : "removed";
      return `${who ?? `user ${String(d["user_id"])}`} ${verb} ${emoji?.name ?? "a reaction"} on message ${String(d["message_id"])}`;
    }
    case "GUILD_MEMBER_ADD":
      return `${username("user", "a member")} joined`;
    case "GUILD_MEMBER_REMOVE":
      return `${username("user", "a member")} left`;
    case "GUILD_MEMBER_UPDATE":
      return `${username("user", "a member")} was updated`;
    case "GUILD_BAN_ADD":
      return `${username("user", "a user")} banned`;
    case "GUILD_BAN_REMOVE":
      return `${username("user", "a user")} unbanned`;
    case "GUILD_ROLE_CREATE":
    case "GUILD_ROLE_UPDATE": {
      const role = d["role"] as { name?: string } | undefined;
      return `role ${role?.name ?? "?"} ${type === "GUILD_ROLE_CREATE" ? "created" : "updated"}`;
    }
    case "GUILD_ROLE_DELETE":
      return `role ${String(d["role_id"])} deleted`;
    case "CHANNEL_CREATE":
    case "CHANNEL_UPDATE":
    case "CHANNEL_DELETE":
    case "THREAD_CREATE":
    case "THREAD_UPDATE":
    case "THREAD_DELETE": {
      const verb = type.endsWith("CREATE") ? "created" : type.endsWith("DELETE") ? "deleted" : "updated";
      const kind = type.startsWith("THREAD") ? "thread" : "channel";
      return `${kind} ${String(d["name"] ?? d["id"])} ${verb}`;
    }
    case "VOICE_STATE_UPDATE": {
      const who = (d["member"] as { user?: { username?: string } } | undefined)?.user?.username ?? String(d["user_id"]);
      return d["channel_id"] ? `${who} is in voice channel ${String(d["channel_id"])}` : `${who} left voice`;
    }
    case "INVITE_CREATE":
      return `invite ${String(d["code"])} created by ${username("inviter", "someone")}`;
    case "INVITE_DELETE":
      return `invite ${String(d["code"])} deleted`;
    default:
      return type;
  }
}
