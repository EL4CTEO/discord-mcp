import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayDispatchPayload } from "discord-api-types/v10";
import { GatewayBridge } from "../src/discord/gateway.js";
import type { DiscordRest } from "../src/discord/rest.js";
import { config } from "./helpers.js";

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

afterEach(() => vi.useRealTimers());

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

    const event = await g.waitFor((e) => (e.content ?? "").includes("needle"), 10, { afterSeq: 0 });
    expect(event?.summary.includes("needle")).toBe(false);
    expect(event?.content).toContain("needle");
  });

  it("returns an already-buffered event when waiting with after_seq", async () => {
    const g = gateway();
    g.ingest(message("early"));
    const event = await g.waitFor(() => true, 10, { afterSeq: 0 });
    expect(event?.seq).toBe(1);
  });

  it("resolves a waiter when a matching event arrives", async () => {
    const g = gateway();
    const pending = g.waitFor((e) => e.channel_id === "c2", 1000);
    g.ingest(message("wrong channel", "c1"));
    g.ingest(message("right channel", "c2"));
    await expect(pending).resolves.toMatchObject({ channel_id: "c2" });
  });

  it("stops waiting when the call is cancelled", async () => {
    const g = gateway();
    const controller = new AbortController();
    const pending = g.waitFor(() => true, 60_000, { signal: controller.signal });
    controller.abort();
    await expect(pending).resolves.toBeUndefined();
  });

  it("does not drop the socket for idleness while a wait is in progress", async () => {
    vi.useFakeTimers();
    const g = gateway({ gatewayIdleMs: 10_000 });
    const pending = g.waitFor(() => true, 30_000);

    await vi.advanceTimersByTimeAsync(25_000);
    expect(g.disconnects).toBe(0);

    await vi.advanceTimersByTimeAsync(10_000);
    await expect(pending).resolves.toBeUndefined();
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
});
