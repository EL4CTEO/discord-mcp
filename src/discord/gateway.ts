import { CompressionMethod, WebSocketManager, WebSocketShardEvents, WebSocketShardStatus } from "@discordjs/ws";
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

/**
 * Events whose `user` is the member affected, not whoever caused the change.
 * Recording that member as the actor would make from_author match the wrong person.
 */
const SUBJECT_EVENTS = new Set<string>([
  "GUILD_MEMBER_ADD",
  "GUILD_MEMBER_REMOVE",
  "GUILD_MEMBER_UPDATE",
  "GUILD_BAN_ADD",
  "GUILD_BAN_REMOVE",
]);

/** One received gateway dispatch, trimmed to what an agent can act on. */
export interface BufferedEvent {
  seq: number;
  type: string;
  at: string;
  guild_id?: string;
  channel_id?: string;
  message_id?: string;
  /** Who caused the event. */
  user?: string;
  user_id?: string;
  /** Who the event happened to, for joins, leaves, bans and member updates. */
  target_user?: string;
  target_user_id?: string;
  summary: string;
  /** Full message text for message events; used for matching, never clipped. */
  content?: string;
  data: unknown;
}

/** Why a waitFor call returned. */
export type WaitOutcome = "matched" | "timeout" | "cancelled" | "closed";

/** How a waitFor call ended: the matching event, or why nothing matched. */
export type WaitResult =
  | { reason: "matched"; event: BufferedEvent }
  | { reason: Exclude<WaitOutcome, "matched">; event?: undefined };

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
  4010: {
    message: "Discord rejected the shard configuration as invalid.",
    hint: "This is a bug in discord-mcp; please report it.",
  },
  4011: {
    message: "This bot is in too many servers for a single shard.",
    hint: "discord-mcp runs one shard, so it cannot serve a bot this large yet.",
  },
  4012: {
    message: "Discord rejected the gateway API version.",
    hint: "Update discord-mcp to the latest version.",
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

/** Pending waitFor calls allowed at once; each holds a timer and a listener. */
const MAX_WAITS = 20;

/**
 * Teardown re-checks. The library can reopen a shard shortly after destroy()
 * (its own recovery path), so a destroyed manager is checked and destroyed again.
 */
const DISCARD_CHECKS = 5;
const DISCARD_INTERVAL_MS = 500;

/** Teardown never holds up a caller longer than this, even if destroy() stalls. */
const TEARDOWN_CAP_MS = 2_000;

type DispatchListener = (payload: GatewayDispatchPayload) => void;

/** The outcome handed to waits ended by disconnect(); also tells finish() not to re-arm the idle timer. */
const CLOSED: WaitResult = { reason: "closed" };

/** A pending waitFor call. `close` fires on disconnect so the caller learns the stream ended. */
interface Waiter {
  offer(event: BufferedEvent): void;
  close(): void;
}

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
  readonly #waiters = new Set<Waiter>();
  readonly #listeners = new Set<DispatchListener>();

  #manager: WebSocketManager | undefined;
  #connecting: Promise<void> | undefined;
  #idleTimer: NodeJS.Timeout | undefined;
  #seq = 0;
  #startedAt: string | undefined;
  #lastError: string | undefined;
  #privilegedRefused = false;
  /** Fails the handshake in progress, so disconnect() does not leave its caller waiting out the timeout. */
  #abortHandshake: ((error: ToolError) => void) | undefined;

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

  /** Sequence number of the oldest event still buffered, or undefined when the buffer is empty. */
  get oldestSeq(): number | undefined {
    return this.#buffer[0]?.seq;
  }

  /**
   * False when message content and member events are unavailable: either
   * disabled by config, or Discord refused the privileged intents.
   */
  get privilegedAvailable(): boolean {
    return this.#config.privilegedIntents && !this.#privilegedRefused;
  }

  /** Message of the most recent gateway error or fatal close, for diagnostics. */
  get lastError(): string | undefined {
    return this.#lastError;
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
    const privileged = this.privilegedAvailable;
    try {
      await this.#open(privileged ? BASE_INTENTS | PRIVILEGED_INTENTS : BASE_INTENTS);
    } catch (error) {
      if (!privileged || !(error instanceof ToolError) || error.code !== 4014) throw error;
      // Discord refuses the whole identify when a privileged intent is off in the
      // portal. Retry once with the base intents so messages and reactions still flow.
      this.#privilegedRefused = true;
      process.stderr.write(
        "discord-mcp: privileged intents refused; continuing without message content and member events.\n",
      );
      await this.#open(BASE_INTENTS);
    }
  }

  /** Opens one manager with the given intents and waits for READY. */
  async #open(intents: number): Promise<void> {
    const manager = new WebSocketManager({
      token: this.#config.token,
      intents,
      rest: this.#rest.raw,
      // node:zlib transport compression: no native addon needed, and it cuts
      // gateway bandwidth several-fold on busy servers.
      compression: CompressionMethod.ZlibNative,
      initialPresence: null,
    });

    // Only the current manager may feed the buffer. A discarded manager can still
    // deliver a dispatch from a socket the library reopened; counting it would
    // ingest every event twice.
    manager.on(WebSocketShardEvents.Dispatch, (payload: GatewayDispatchPayload) => {
      if (this.#manager === manager) this.ingest(payload);
    });

    // The library emits Error for some closes (bad token, invalid shard), and an
    // EventEmitter with no 'error' listener throws. This listener must always exist.
    manager.on(WebSocketShardEvents.Error, (error: Error) => {
      this.#lastError = error.message;
      process.stderr.write(`discord-mcp: gateway error: ${error.message}\n`);
      if (this.#manager === manager && !this.#connecting) void this.disconnect();
    });

    // After a fatal close the library stops reconnecting, so forget the
    // manager: the next call reconnects and reports the real problem, instead
    // of waiting forever on a dead socket.
    manager.on(WebSocketShardEvents.Closed, (code: number) => {
      const fatal = FATAL_CLOSE[code];
      if (!fatal) return;
      this.#lastError = fatal.message;
      if (this.#manager === manager && !this.#connecting) void this.disconnect();
    });

    this.#manager = manager;

    try {
      await this.#awaitReady(manager);
      // disconnect() can run while READY is being delivered; a manager it dropped must not stay live.
      if (this.#manager !== manager) throw closedWhileConnecting();
      this.#startedAt = new Date().toISOString();
    } catch (error) {
      if (this.#manager === manager) this.#manager = undefined;
      await this.#discard(manager);
      throw error;
    }
  }

  /**
   * Resolves once the shard is READY; rejects on timeout, a fatal close, or disconnect().
   *
   * connect() alone would wait forever on a rejected token, so it is raced
   * against both. The timer is always cleared, so a failed connect can never
   * leave a stray rejection behind to crash the process later.
   */
  #awaitReady(manager: WebSocketManager): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (error?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        manager.off(WebSocketShardEvents.Closed, onClosed);
        this.#abortHandshake = undefined;
        if (error === undefined) resolve();
        else reject(error);
      };

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

      this.#abortHandshake = (error) => settle(error);
      manager.on(WebSocketShardEvents.Closed, onClosed);
      manager.connect().then(
        // connect() can finish after the handshake was abandoned (its REST call
        // outlived the timer). The manager was discarded with no shards yet, so
        // the socket it just opened has to be closed here or it lives on unseen.
        () => (settled ? void Promise.resolve(manager.destroy()).catch(() => undefined) : settle()),
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

    const who = actor(data);
    if (SUBJECT_EVENTS.has(payload.t)) {
      if (who) {
        event.target_user = who.name;
        event.target_user_id = who.id;
      }
    } else if (who) {
      event.user = who.name;
      event.user_id = who.id;
    } else if (typeof data["user_id"] === "string") {
      event.user_id = data["user_id"];
    }

    if (typeof data["content"] === "string") event.content = data["content"];

    this.#buffer.push(event);
    if (this.#buffer.length > this.#config.eventBufferSize) this.#buffer.shift();

    for (const waiter of [...this.#waiters]) waiter.offer(event);
  }

  /**
   * Buffered events, oldest first, optionally filtered.
   *
   * With a cursor (afterSeq) the oldest matches come first, so a poller that
   * pages forward with last_seq never skips anything. Without one the newest
   * matches are returned, which is what "what just happened?" wants.
   */
  recent(options: { match?: (event: BufferedEvent) => boolean; afterSeq?: number; limit: number }): BufferedEvent[] {
    const { match, afterSeq, limit } = options;
    const matched = this.#buffer.filter((e) => e.seq > (afterSeq ?? 0) && (!match || match(e)));
    return afterSeq === undefined ? matched.slice(-limit) : matched.slice(0, limit);
  }

  /**
   * Resolves with the first event matching `predicate`, or with why it stopped:
   * timeout, cancellation, or the connection closing.
   *
   * With `afterSeq`, events already buffered past that point are checked
   * first - so an agent that read the buffer and then decided to wait cannot
   * miss something that arrived in between. The timeout starts now, not once
   * the socket is open, so a slow connect cannot stretch the caller's budget.
   */
  async waitFor(
    predicate: (event: BufferedEvent) => boolean,
    timeoutMs: number,
    options: { afterSeq?: number; signal?: AbortSignal } = {},
  ): Promise<WaitResult> {
    // Anything arriving after this point counts too, so the default starting point is "now".
    const since = options.afterSeq ?? this.#seq;
    const { signal } = options;

    const early = this.#buffer.find((e) => e.seq > since && predicate(e));
    if (early) return { event: early, reason: "matched" };
    if (signal?.aborted) return { reason: "cancelled" };
    if (this.#waiters.size >= MAX_WAITS) {
      throw new ToolError(`Too many event waits are already pending (limit ${MAX_WAITS}).`, {
        code: "TOO_MANY_WAITS",
        hint: "Let a pending wait finish or cancel it, then retry.",
      });
    }

    return new Promise<WaitResult>((resolve, reject) => {
      let finished = false;
      const finish = (outcome: WaitResult | { error: unknown }): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.#waiters.delete(waiter);
        signal?.removeEventListener("abort", onAbort);
        if (outcome !== CLOSED) this.#touch();
        if ("error" in outcome) reject(outcome.error);
        else resolve(outcome);
      };

      const waiter: Waiter = {
        offer: (event) => {
          if (event.seq > since && predicate(event)) finish({ event, reason: "matched" });
        },
        close: () => finish(CLOSED),
      };
      const onAbort = (): void => finish({ reason: "cancelled" });
      const timer = setTimeout(() => finish({ reason: "timeout" }), timeoutMs);

      this.#waiters.add(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
      // Events can arrive while the socket opens and are offered to the waiter above.
      // A failed connect is the caller's problem, so it is reported rather than retried here.
      this.ensureConnected().catch((error: unknown) => finish({ error }));
    });
  }

  /**
   * Restarts the idle countdown that eventually drops the socket.
   *
   * The countdown never fires while a wait is in progress, or while a connect
   * is still in flight: a five-minute wait must not lose its socket to a
   * two-minute idle timeout halfway through.
   */
  #touch(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => {
      if (this.#waiters.size > 0 || this.#connecting) this.#touch();
      else void this.disconnect();
    }, this.#config.gatewayIdleMs);
    this.#idleTimer.unref();
  }

  /**
   * Drops the socket and ends every pending wait with reason "closed".
   * Bounded in time: a stalled destroy() cannot hang shutdown.
   */
  async disconnect(): Promise<void> {
    if (this.#idleTimer) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = undefined;
    }

    this.#abortHandshake?.(closedWhileConnecting());
    for (const waiter of [...this.#waiters]) waiter.close();

    const manager = this.#manager;
    this.#manager = undefined;
    this.#startedAt = undefined;
    if (manager) await this.#discard(manager);
  }

  /**
   * Tears a manager down so no socket outlives it.
   *
   * destroy() can stall, and the library can reopen a shard after it, so this
   * re-checks the shard states and destroys again while any is not idle. The
   * whole thing is capped so a caller never waits on a dead connection.
   */
  async #discard(manager: WebSocketManager): Promise<void> {
    const deadline = Date.now() + TEARDOWN_CAP_MS;
    await within(() => manager.destroy(), deadline);
    let idleOnce = false;

    for (let check = 0; check < DISCARD_CHECKS; check++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await pause(Math.min(DISCARD_INTERVAL_MS, remaining));

      const status = await within(() => manager.fetchStatus(), deadline);
      // A failed status read proves nothing, so it never counts as idle.
      const idle = status !== undefined && [...status.value.values()].every((s) => s === WebSocketShardStatus.Idle);
      // The library idles a shard for ~500ms before its own reconnect, so one
      // idle reading is not proof; two in a row are.
      if (idle && idleOnce) return;
      idleOnce = idle;
      if (!idle) await within(() => manager.destroy(), deadline);
    }
    process.stderr.write("discord-mcp: gateway teardown did not confirm every shard closed\n");
  }
}

function closedWhileConnecting(): ToolError {
  return new ToolError("Gateway closed while connecting.", { code: "GATEWAY_CLOSED", hint: "Retry the call." });
}

/** Resolves after `ms`, without keeping the process alive. */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

/**
 * Runs `work` but gives up at `deadline`, resolving to undefined on timeout or
 * failure. Teardown is best-effort, so errors are absorbed here.
 */
function within<T>(work: () => T | PromiseLike<T>, deadline: number): Promise<{ value: T } | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), Math.max(0, deadline - Date.now()));
    timer.unref();
    const finish = (result: { value: T } | undefined): void => {
      clearTimeout(timer);
      resolve(result);
    };
    new Promise<T>((settle) => settle(work())).then(
      (value) => finish({ value }),
      () => finish(undefined),
    );
  });
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

/**
 * One-line, human-readable description of a dispatch. Names and message text
 * are written by strangers, so every run of whitespace collapses to one space:
 * a newline inside a username must not split the summary line.
 */
function summarize(type: string, d: Record<string, unknown>): string {
  return describe(type, d).replace(/\s+/g, " ").trim();
}

function describe(type: string, d: Record<string, unknown>): string {
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
