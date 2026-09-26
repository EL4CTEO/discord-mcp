import { describe, expect, it, vi } from "vitest";
import { Resolver, isSnowflake } from "../src/discord/resolve.js";
import { ToolError } from "../src/lib/errors.js";
import { config } from "./helpers.js";
import type { DiscordRest } from "../src/discord/rest.js";

/** Minimal REST double: routes are matched by substring. */
function fakeRest(routes: Record<string, unknown>): { rest: DiscordRest; calls: string[] } {
  const calls: string[] = [];
  const get = vi.fn(async (route: string) => {
    calls.push(route);
    const match = Object.entries(routes).find(([key]) => route.includes(key));
    if (!match) throw new Error(`unexpected route ${route}`);
    return match[1];
  });
  return { rest: { get } as unknown as DiscordRest, calls };
}

const GUILDS = [
  { id: "111111111111111111", name: "breakout block" },
  { id: "222222222222222222", name: "TestPlace" },
];

describe("isSnowflake", () => {
  it("accepts 17-20 digit ids and rejects names", () => {
    expect(isSnowflake("111111111111111111")).toBe(true);
    expect(isSnowflake("general")).toBe(false);
    expect(isSnowflake("12345")).toBe(false);
  });
});

describe("Resolver.guildId", () => {
  it("resolves a name case- and separator-insensitively", async () => {
    const { rest } = fakeRest({ "/users/@me/guilds": GUILDS });
    const resolver = new Resolver(rest, config());

    await expect(resolver.guildId("Breakout-Block")).resolves.toBe("111111111111111111");
    await expect(resolver.guildId("testplace")).resolves.toBe("222222222222222222");
  });

  it("passes IDs and mentions straight through without an API call", async () => {
    const { rest, calls } = fakeRest({ "/users/@me/guilds": GUILDS });
    const resolver = new Resolver(rest, config());

    await expect(resolver.guildId("999999999999999999")).resolves.toBe("999999999999999999");
    expect(calls).toHaveLength(0);
  });

  it("falls back to the only server when none is given", async () => {
    const { rest } = fakeRest({ "/users/@me/guilds": [GUILDS[0]] });
    await expect(new Resolver(rest, config()).guildId()).resolves.toBe("111111111111111111");
  });

  it("uses DISCORD_DEFAULT_GUILD when several servers exist", async () => {
    const { rest } = fakeRest({ "/users/@me/guilds": GUILDS });
    const resolver = new Resolver(rest, config({ defaultGuild: "TestPlace" }));
    await expect(resolver.guildId()).resolves.toBe("222222222222222222");
  });

  it("asks for a guild, listing the options, when ambiguous", async () => {
    const { rest } = fakeRest({ "/users/@me/guilds": GUILDS });
    const error = await new Resolver(rest, config()).guildId().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ToolError);
    expect((error as ToolError).hint).toContain("breakout block");
    expect((error as ToolError).hint).toContain("TestPlace");
  });

  it("explains how to fix an unknown name", async () => {
    const { rest } = fakeRest({ "/users/@me/guilds": GUILDS });
    const error = await new Resolver(rest, config()).guildId("nope").catch((e: unknown) => e);

    expect((error as ToolError).code).toBe("NOT_FOUND");
    expect((error as ToolError).hint).toContain("breakout block");
  });

  it("caches the guild listing across calls", async () => {
    const { rest, calls } = fakeRest({ "/users/@me/guilds": GUILDS });
    const resolver = new Resolver(rest, config());

    await resolver.guildId("TestPlace");
    await resolver.guildId("breakout block");

    expect(calls).toHaveLength(1);
  });
});

const CHANNELS = [
  { id: "300000000000000001", name: "Text Channels", type: 4 },
  { id: "300000000000000002", name: "general", type: 0 },
  { id: "300000000000000003", name: "General", type: 2 },
  { id: "300000000000000004", name: "team-announcements", type: 0 },
];

describe("Resolver.channelId", () => {
  const resolver = () => {
    const { rest } = fakeRest({ "/channels": CHANNELS });
    return new Resolver(rest, config());
  };

  it("prefers the exact spelling when case is the only difference", async () => {
    // A "general" text channel next to a "General" voice channel is the single
    // most common layout in Discord; it must not read as ambiguous.
    await expect(resolver().channelId("general", "1")).resolves.toBe("300000000000000002");
    await expect(resolver().channelId("General", "1")).resolves.toBe("300000000000000003");
  });

  it("still matches loosely when there is no exact hit", async () => {
    await expect(resolver().channelId("team announcements", "1")).resolves.toBe("300000000000000004");
    await expect(resolver().channelId("announcements", "1")).resolves.toBe("300000000000000004");
  });

  it("strips a leading # and resolves channel mentions", async () => {
    await expect(resolver().channelId("#general", "1")).resolves.toBe("300000000000000002");
    await expect(resolver().channelId("<#300000000000000004>", "1")).resolves.toBe("300000000000000004");
  });

  it("names the channel type when a query is genuinely ambiguous", async () => {
    // "gen" matches both general (text) and General (voice) only loosely, so
    // there is no exact spelling to fall back on.
    const error = (await resolver().channelId("gen", "1").catch((e: unknown) => e)) as ToolError;

    expect(error.code).toBe("AMBIGUOUS");
    expect(error.hint).toContain("text");
    expect(error.hint).toContain("voice");
  });

  it("lists real channels when the name does not exist", async () => {
    const error = (await resolver().channelId("nowhere", "1").catch((e: unknown) => e)) as ToolError;
    expect(error.code).toBe("NOT_FOUND");
    expect(error.hint).toContain("general");
  });
});

describe("single-flight de-duplication", () => {
  it("collapses concurrent identical lookups into one API call", async () => {
    const { rest, calls } = fakeRest({ "/users/@me/guilds": GUILDS });
    const resolver = new Resolver(rest, config());

    // What a cold batch of 10 operations looks like: all resolve at once.
    await Promise.all(Array.from({ length: 10 }, () => resolver.guildId("TestPlace")));

    expect(calls).toHaveLength(1);
  });

  it("re-fetches after the in-flight request settles", async () => {
    const { rest, calls } = fakeRest({ "/channels": CHANNELS });
    const resolver = new Resolver(rest, config());

    await resolver.channelId("general", "1");
    resolver.invalidate("1");
    await resolver.channelId("general", "1");

    expect(calls).toHaveLength(2);
  });
});

describe("Resolver extras", () => {
  it("maps @everyone to the guild id without any lookup", async () => {
    const { rest, calls } = fakeRest({});
    const resolver = new Resolver(rest, config());
    await expect(resolver.roleId("@everyone", "555555555555555555")).resolves.toBe("555555555555555555");
    expect(calls).toHaveLength(0);
  });

  it("falls back to active threads when no channel matches", async () => {
    const { rest } = fakeRest({
      "/threads/active": { threads: [{ id: "400000000000000001", name: "bug-report-42", type: 11 }] },
      "/channels": CHANNELS,
    });
    await expect(new Resolver(rest, config()).channelId("bug-report-42", "1")).resolves.toBe("400000000000000001");
  });

  it("still reports the channel list when neither channels nor threads match", async () => {
    const { rest } = fakeRest({ "/threads/active": { threads: [] }, "/channels": CHANNELS });
    const error = (await new Resolver(rest, config()).channelId("nowhere", "1").catch((e: unknown) => e)) as ToolError;
    expect(error.code).toBe("NOT_FOUND");
    expect(error.hint).toContain("general");
  });

  it("folds a created channel into the cache instead of refetching", async () => {
    const { rest, calls } = fakeRest({ "/channels": CHANNELS });
    const resolver = new Resolver(rest, config());

    await resolver.channels("1");
    resolver.upsertChannel("1", { id: "300000000000000009", name: "fresh", type: 0 } as never);

    await expect(resolver.channelId("fresh", "1")).resolves.toBe("300000000000000009");
    expect(calls).toHaveLength(1);
  });

  it("applies live channel deletes from the gateway", async () => {
    const { rest } = fakeRest({ "/channels": CHANNELS, "/threads/active": { threads: [] } });
    const resolver = new Resolver(rest, config());
    await resolver.channels("1");

    resolver.applyDispatch({
      t: "CHANNEL_DELETE",
      d: { id: "300000000000000004", guild_id: "1", type: 0, name: "team-announcements" },
    } as never);

    const error = (await resolver.channelId("team-announcements", "1").catch((e: unknown) => e)) as ToolError;
    expect(error.code).toBe("NOT_FOUND");
  });

  it("does not pin a failed self lookup forever", async () => {
    let attempt = 0;
    const rest = {
      get: vi.fn(async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("network blip");
        return { id: "999999999999999999", username: "bot" };
      }),
    } as unknown as DiscordRest;
    const resolver = new Resolver(rest, config());

    await expect(resolver.selfId()).rejects.toThrow("network blip");
    await expect(resolver.selfId()).resolves.toBe("999999999999999999");
  });

  it("caches member name lookups", async () => {
    const { rest, calls } = fakeRest({
      "/members/search": [{ user: { id: "700000000000000001", username: "alice" }, nick: null, roles: [] }],
    });
    const resolver = new Resolver(rest, config());

    await resolver.memberId("alice", "1");
    await resolver.memberId("Alice", "1");
    expect(calls).toHaveLength(1);
  });
});
