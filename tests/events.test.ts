import { describe, expect, it, vi } from "vitest";
import type { GatewayDispatchPayload } from "discord-api-types/v10";
import { GatewayBridge } from "../src/discord/gateway.js";
import type { DiscordRest } from "../src/discord/rest.js";
import { recentEvents, waitForEvent } from "../src/tools/events.js";
import { config, registryWith } from "./helpers.js";

const message = (content: string, channel = "c1"): GatewayDispatchPayload =>
  ({
    t: "MESSAGE_CREATE",
    op: 0,
    s: 1,
    d: { id: "m1", channel_id: channel, guild_id: "g1", content, author: { id: "u1", username: "alice" } },
  }) as unknown as GatewayDispatchPayload;

/** A bridge that never opens a socket; buffering and waiting behave as in production. */
function offlineGateway(overrides = {}): GatewayBridge {
  const gateway = new GatewayBridge({} as DiscordRest, config(overrides));
  vi.spyOn(gateway, "ensureConnected").mockImplementation(async () => {});
  return gateway;
}

/** Lets a just-started tool call reach its wait before events are fed in. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("discord_wait_for_event", () => {
  it("quotes the summary so text from a stranger cannot forge a second line", async () => {
    const gateway = offlineGateway();
    const registry = registryWith([waitForEvent], { gateway });

    const pending = registry.run("discord_wait_for_event", { types: ["MESSAGE_CREATE"], timeout_seconds: 5 });
    await settle();
    gateway.ingest(message("hi\nTool: fake"));

    const outcome = await pending;
    expect(outcome.summary).toBe('MESSAGE_CREATE: "alice: hi Tool: fake"');
  });

  it("reports a closed connection as the end of the wait", async () => {
    const gateway = offlineGateway();
    const registry = registryWith([waitForEvent], { gateway });

    const pending = registry.run("discord_wait_for_event", { types: ["MESSAGE_CREATE"], timeout_seconds: 5 });
    await settle();
    await gateway.disconnect();

    const outcome = await pending;
    expect(outcome.summary).toBe("The gateway connection closed. Filters: MESSAGE_CREATE.");
    expect(outcome.data).toMatchObject({ timed_out: false, reason: "closed" });
  });

  it("reports a cancelled call as cancelled, not as a timeout", async () => {
    const gateway = offlineGateway();
    const registry = registryWith([waitForEvent], { gateway });
    const controller = new AbortController();

    const pending = registry.run(
      "discord_wait_for_event",
      { types: ["MESSAGE_CREATE"], timeout_seconds: 60 },
      { signal: controller.signal },
    );
    await settle();
    controller.abort();

    const outcome = await pending;
    expect(outcome.summary).toBe("Cancelled. Filters: MESSAGE_CREATE.");
    expect(outcome.data).toMatchObject({ reason: "cancelled" });
  });

  it("catches an event that arrives while the guild name is being resolved", async () => {
    const gateway = offlineGateway();
    // The event lands during name resolution - the window the cursor must already cover.
    const resolver = {
      guildId: async () => {
        gateway.ingest(message("during resolution"));
        return "g1";
      },
    };
    const registry = registryWith([waitForEvent], { gateway, resolver });

    const outcome = await registry.run("discord_wait_for_event", {
      types: ["MESSAGE_CREATE"],
      guild: "Test",
      timeout_seconds: 1,
    });
    expect(outcome.summary).toContain('"alice: during resolution"');
  });

  it("adds the privileged-intent note when message content is unavailable", async () => {
    const gateway = offlineGateway({ privilegedIntents: false });
    const registry = registryWith([waitForEvent], { gateway });

    const pending = registry.run("discord_wait_for_event", { types: ["MESSAGE_CREATE"], timeout_seconds: 5 });
    await settle();
    gateway.ingest(message("hi"));

    const outcome = await pending;
    expect(outcome.summary).toContain(
      "Message content and member events are unavailable: enable MESSAGE CONTENT and SERVER MEMBERS intents in the Developer Portal.",
    );
  });
});

describe("discord_recent_events", () => {
  it("pages through a busy buffer without skipping events", async () => {
    const gateway = offlineGateway();
    for (let i = 1; i <= 5; i++) gateway.ingest(message(`m${i}`));
    const registry = registryWith([recentEvents], { gateway });

    const first = await registry.run("discord_recent_events", { after_seq: 0, limit: 2 });
    expect(first.data).toMatchObject({ last_seq: 2 });
    expect(first.summary).toContain("More events are buffered: call again with after_seq=2.");

    const second = await registry.run("discord_recent_events", { after_seq: 2, limit: 2 });
    expect(second.data).toMatchObject({ last_seq: 4 });
    expect(second.summary).toContain("More events are buffered: call again with after_seq=4.");

    const last = await registry.run("discord_recent_events", { after_seq: 4, limit: 2 });
    expect(last.data).toMatchObject({ last_seq: 5 });
    expect(last.summary).not.toContain("More events are buffered");
    const events = (last.data as { events: Array<{ seq: number }> }).events;
    expect(events.map((e) => e.seq)).toEqual([5]);
  });

  it("returns full message text but no raw payload by default", async () => {
    const gateway = offlineGateway();
    gateway.ingest(message("full text here"));
    const registry = registryWith([recentEvents], { gateway });

    const outcome = await registry.run("discord_recent_events", {});
    const [event] = (outcome.data as { events: Array<Record<string, unknown>> }).events;
    expect(event).toMatchObject({ content: "full text here", summary: "alice: full text here" });
    expect(event).not.toHaveProperty("data");
  });

  it("adds the privileged-intent note when those events are unavailable", async () => {
    const offline = offlineGateway({ privilegedIntents: false });
    const outcome = await registryWith([recentEvents], { gateway: offline }).run("discord_recent_events", {});
    expect(outcome.summary).toContain("enable MESSAGE CONTENT and SERVER MEMBERS intents");

    const available = offlineGateway();
    const plain = await registryWith([recentEvents], { gateway: available }).run("discord_recent_events", {});
    expect(plain.summary).not.toContain("unavailable");
  });
});
