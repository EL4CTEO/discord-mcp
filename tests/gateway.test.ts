import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventEmitter } from "node:events";
import type { GatewayDispatchPayload } from "discord-api-types/v10";
import { GatewayIntentBits } from "discord-api-types/v10";
import { WebSocketShardStatus } from "@discordjs/ws";
import { GatewayBridge } from "../src/discord/gateway.js";
import type { DiscordRest } from "../src/discord/rest.js";
import { config } from "./helpers.js";

/**
 * Stands in for the library's WebSocketManager so the socket paths run without
 * a network. `handshake` decides what connect() does for each manager created.
 */
type FakeManager = EventEmitter & {
  options: { intents: number };
  destroys: number;
  statusReplies: number[];
};

const fake = vi.hoisted(() => ({
  managers: [] as FakeManager[],
  handshake: undefined as undefined | ((manager: FakeManager) => Promise<void>),
}));

vi.mock("@discordjs/ws", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@discordjs/ws")>();
  const { EventEmitter } = await import("node:events");

  class FakeManager extends EventEmitter {
    readonly options: { intents: number };
    destroys = 0;
    statusReplies: number[] = [];

    constructor(options: { intents: number }) {
      super();
      this.options = options;
      fake.managers.push(this as unknown as FakeManager);
    }

    connect(): Promise<void> {
      return fake.handshake?.(this as unknown as FakeManager) ?? Promise.resolve();
    }

    async destroy(): Promise<void> {
      this.destroys += 1;
    }

    async fetchStatus(): Promise<Map<number, number>> {
      return new Map([[0, this.statusReplies.shift() ?? actual.WebSocketShardStatus.Idle]]);
    }
  }

  return { ...actual, WebSocketManager: FakeManager };
});

const PRIVILEGED = GatewayIntentBits.MessageContent | GatewayIntentBits.GuildMembers;

/** A bridge whose socket is always "open", fed by hand. */
class TestGateway extends GatewayBridge {
  disconnects = 0;
  override async ensureConnected(): Promise<void> {}
  override async disconnect(): Promise<void> {
    this.disconnects += 1;
  }
}

const message = (content: string, channel = "c1"): GatewayDispatchPayload =>
  ({
    t: "MESSAGE_CREATE",
    op: 0,
    s: 1,
    d: { id: "m1", channel_id: channel, guild_id: "g1", content, author: { id: "u1", username: "alice" } },
  }) as unknown as GatewayDispatchPayload;

const gateway = (overrides = {}) => new TestGateway({} as DiscordRest, config(overrides));

/** Real bridge logic with the socket replaced by `connect`. Nothing is opened. */
function offline(connect: () => Promise<void> = async () => {}, overrides = {}): GatewayBridge {
  const g = new GatewayBridge({} as DiscordRest, config(overrides));
  vi.spyOn(g, "ensureConnected").mockImplementation(connect);
  return g;
}

/** Real bridge with the fake manager: exercises connect, discard and the socket listeners. */
const bridge = (overrides = {}) => new GatewayBridge({} as DiscordRest, config(overrides));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fake.managers.length = 0;
  fake.handshake = undefined;
});

describe("GatewayBridge", () => {
  it("buffers agent-relevant events and skips handshake noise", () => {
    const g = gateway();
    g.ingest({ t: "GUILD_CREATE", op: 0, s: 1, d: { id: "g1" } } as unknown as GatewayDispatchPayload);
    g.ingest(message("hi"));

    const events = g.recent({ limit: 10 });
    expect(events.map((e) => e.type)).toEqual(["MESSAGE_CREATE"]);
    expect(events[0]).toMatchObject({ user: "alice", user_id: "u1", channel_id: "c1", guild_id: "g1" });
  });

  it("matches `contains` against the full text, not the clipped summary", async () => {
    const g = gateway();
    const long = `${"a".repeat(300)} needle`;
    g.ingest(message(long));

    const { event } = await g.waitFor((e) => (e.content ?? "").includes("needle"), 10, { afterSeq: 0 });
    expect(event?.summary.includes("needle")).toBe(false);
    expect(event?.content).toContain("needle");
  });

  it("returns an already-buffered event when waiting with after_seq", async () => {
    const g = gateway();
    g.ingest(message("early"));
    const result = await g.waitFor(() => true, 10, { afterSeq: 0 });
    expect(result).toMatchObject({ reason: "matched", event: { seq: 1 } });
  });

  it("resolves a waiter when a matching event arrives", async () => {
    const g = gateway();
    const pending = g.waitFor((e) => e.channel_id === "c2", 1000);
    g.ingest(message("wrong channel", "c1"));
    g.ingest(message("right channel", "c2"));
    await expect(pending).resolves.toMatchObject({ reason: "matched", event: { channel_id: "c2" } });
  });

  it("stops waiting when the call is cancelled", async () => {
    const g = gateway();
    const controller = new AbortController();
    const pending = g.waitFor(() => true, 60_000, { signal: controller.signal });
    controller.abort();
    await expect(pending).resolves.toEqual({ reason: "cancelled" });
  });

  it("does not drop the socket for idleness while a wait is in progress", async () => {
    vi.useFakeTimers();
    const g = gateway({ gatewayIdleMs: 10_000 });
    const pending = g.waitFor(() => true, 30_000);

    await vi.advanceTimersByTimeAsync(25_000);
    expect(g.disconnects).toBe(0);

    await vi.advanceTimersByTimeAsync(10_000);
    await expect(pending).resolves.toEqual({ reason: "timeout" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(g.disconnects).toBe(1);
  });

  it("keeps the buffer bounded", () => {
    const g = gateway({ eventBufferSize: 20 });
    for (let i = 0; i < 50; i++) g.ingest(message(`m${i}`));
    const events = g.recent({ limit: 100 });
    expect(events).toHaveLength(20);
    expect(events[0]?.seq).toBe(31);
  });

  it("forwards every dispatch to cache listeners", () => {
    const g = gateway();
    const seen: string[] = [];
    g.onDispatch((p) => seen.push(p.t));
    g.ingest({ t: "GUILD_CREATE", op: 0, s: 1, d: { id: "g1" } } as unknown as GatewayDispatchPayload);
    expect(seen).toEqual(["GUILD_CREATE"]);
  });

  it("pages forward oldest-first when given a cursor", () => {
    const g = gateway();
    for (let i = 0; i < 10; i++) g.ingest(message(`m${i}`));

    expect(g.recent({ afterSeq: 0, limit: 3 }).map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(g.recent({ afterSeq: 3, limit: 3 }).map((e) => e.seq)).toEqual([4, 5, 6]);
    // Without a cursor the newest are returned, as "what just happened" expects.
    expect(g.recent({ limit: 3 }).map((e) => e.seq)).toEqual([8, 9, 10]);
  });

  it("ignores live events at or before afterSeq", async () => {
    const g = gateway();
    const pending = g.waitFor((e) => e.type === "MESSAGE_CREATE", 1000, { afterSeq: 5 });
    for (let i = 0; i < 5; i++) g.ingest(message(`old${i}`));
    g.ingest(message("new"));

    await expect(pending).resolves.toMatchObject({ reason: "matched", event: { seq: 6, content: "new" } });
  });

  it("resolves pending waits as closed when the connection is dropped", async () => {
    const g = offline();
    const pending = g.waitFor(() => true, 60_000);
    await g.disconnect();
    await expect(pending).resolves.toEqual({ reason: "closed" });
  });

  it("refuses a 21st concurrent wait with TOO_MANY_WAITS", async () => {
    const g = offline();
    const waits = Array.from({ length: 20 }, () => g.waitFor(() => false, 60_000));

    await expect(g.waitFor(() => false, 60_000)).rejects.toMatchObject({ code: "TOO_MANY_WAITS" });

    await g.disconnect();
    await expect(Promise.all(waits)).resolves.toEqual(Array.from({ length: 20 }, () => ({ reason: "closed" })));
  });

  it("records a ban's target, not the moderator, as the event's user", () => {
    const g = gateway();
    g.ingest({
      t: "GUILD_BAN_ADD",
      op: 0,
      s: 2,
      d: { guild_id: "g1", user: { id: "u9", username: "mallory" } },
    } as unknown as GatewayDispatchPayload);

    const [event] = g.recent({ limit: 10 });
    expect(event).toMatchObject({ target_user: "mallory", target_user_id: "u9", summary: "mallory banned" });
    expect(event?.user).toBeUndefined();
    expect(event?.user_id).toBeUndefined();
  });

  it("records an invite's creator as the event's user", () => {
    const g = gateway();
    g.ingest({
      t: "INVITE_CREATE",
      op: 0,
      s: 3,
      d: { guild_id: "g1", channel_id: "c1", code: "abc123", inviter: { id: "u5", username: "carol" } },
    } as unknown as GatewayDispatchPayload);

    const [event] = g.recent({ limit: 10 });
    expect(event).toMatchObject({ user: "carol", user_id: "u5", summary: "invite abc123 created by carol" });
  });

  it("collapses line breaks and runs of whitespace in summaries, but not in content", () => {
    const g = gateway();
    g.ingest(message("line one\n\nline\ttwo"));

    const [event] = g.recent({ limit: 1 });
    expect(event?.summary).toBe("alice: line one line two");
    expect(event?.content).toBe("line one\n\nline\ttwo");
  });

  it("times out from the moment of the call, even while the connection is still opening", async () => {
    vi.useFakeTimers();
    const g = offline(() => new Promise(() => {}));
    const pending = g.waitFor(() => true, 1_000);

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toEqual({ reason: "timeout" });
  });

  it("returns as soon as the call is cancelled, while the connection is still opening", async () => {
    const g = offline(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = g.waitFor(() => true, 60_000, { signal: controller.signal });
    controller.abort();
    await expect(pending).resolves.toEqual({ reason: "cancelled" });
  });
});

describe("GatewayBridge socket lifecycle (library replaced by a fake)", () => {
  it("retries once without privileged intents when Discord refuses them", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    fake.handshake = (manager) => {
      if ((manager.options.intents & PRIVILEGED) === 0) return Promise.resolve();
      setImmediate(() => manager.emit("closed", 4014, 0));
      return new Promise(() => {});
    };

    const g = bridge();
    await g.ensureConnected();

    expect(g.privilegedAvailable).toBe(false);
    expect(g.isConnected).toBe(true);
    expect(fake.managers).toHaveLength(2);
    expect(fake.managers[0]?.destroys).toBeGreaterThan(0);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("privileged intents refused"));
    await g.disconnect();
  });

  it("reports gateway errors on stderr instead of throwing, and drops the socket", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    fake.handshake = () => Promise.resolve();

    const g = bridge();
    await g.ensureConnected();
    const [manager] = fake.managers;

    expect(() => manager?.emit("error", new Error("Used invalid intents"), 0)).not.toThrow();
    expect(stderr).toHaveBeenCalledWith("discord-mcp: gateway error: Used invalid intents\n");
    expect(stdout).not.toHaveBeenCalled();
    expect(g.lastError).toBe("Used invalid intents");
    expect(g.isConnected).toBe(false);
    expect(manager?.destroys).toBeGreaterThan(0);
  });

  it("ignores dispatches from a manager it has already discarded", async () => {
    fake.handshake = () => Promise.resolve();

    const g = bridge();
    await g.ensureConnected();
    const [manager] = fake.managers;
    manager?.emit("dispatch", message("live"));
    await g.disconnect();
    manager?.emit("dispatch", message("late"));

    expect(g.recent({ limit: 10 }).map((e) => e.content)).toEqual(["live"]);
  });

  it("fails a handshake that disconnect() interrupts, without waiting out the timeout", async () => {
    fake.handshake = () => new Promise(() => {});

    const g = bridge();
    const outcome = g.ensureConnected().then(
      () => "connected",
      (error: unknown) => error,
    );
    await g.disconnect();

    await expect(outcome).resolves.toMatchObject({ code: "GATEWAY_CLOSED" });
  });

  it("destroys again when a shard is still active after a timed-out connect", async () => {
    fake.handshake = (manager) => {
      manager.statusReplies = [WebSocketShardStatus.Ready];
      return new Promise(() => {});
    };

    const g = bridge({ requestTimeoutMs: 5 });
    await expect(g.ensureConnected()).rejects.toMatchObject({ code: "GATEWAY_TIMEOUT" });

    expect(fake.managers[0]?.destroys).toBe(2);
    expect(g.isConnected).toBe(false);
  });

  it("does not drop a connection that is still opening when the idle countdown fires", async () => {
    vi.useFakeTimers();
    let finishHandshake = (): void => {};
    fake.handshake = () =>
      new Promise<void>((resolve) => {
        finishHandshake = resolve;
      });

    const g = bridge({ gatewayIdleMs: 10_000 });
    const opening = g.ensureConnected();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(fake.managers[0]?.destroys).toBe(0);

    finishHandshake();
    await opening;
    expect(g.isConnected).toBe(true);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(g.isConnected).toBe(false);
  });

  it("ends pending waits with the last error when Discord closes the socket fatally", async () => {
    fake.handshake = () => Promise.resolve();

    const g = bridge();
    await g.ensureConnected();
    const pending = g.waitFor(() => false, 60_000);
    fake.managers[0]?.emit("closed", 4004, 0);

    await expect(pending).resolves.toEqual({ reason: "closed" });
    expect(g.lastError).toBe("Discord rejected the bot token.");
  });
});
