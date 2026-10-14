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

/** Runs `fn` and returns the ToolError it throws, failing the test if it does not throw. */
async function toolErrorOf(fn: () => Promise<unknown>): Promise<ToolError> {
  const error = await fn().then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ToolError);
  return error as ToolError;
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

  it("rejects 20-digit values above the 64-bit snowflake range", () => {
    expect(isSnowflake("18446744073709551615")).toBe(true);
    expect(isSnowflake("18446744073709551616")).toBe(false);
    expect(isSnowflake("99999999999999999999")).toBe(false);
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
});

describe("member matching", () => {
  const member = (id: string, username: string, extra: Record<string, unknown> = {}) => ({
    user: { id, username, global_name: null, ...extra },
    nick: null,
    roles: [],
  });

  it("does not reuse a stale name -> id entry: two lookups both search", async () => {
    // Someone renamed themselves (or a different "sam" joined) between the two calls.
    const get = vi
      .fn()
      .mockResolvedValueOnce([{ user: { id: "700000000000000001", username: "sam" }, nick: "Sam", roles: [] }])
      .mockResolvedValueOnce([{ user: { id: "700000000000000002", username: "sam" }, nick: "Sam", roles: [] }]);
    const resolver = new Resolver({ get } as unknown as DiscordRest, config());

    await expect(resolver.memberId("sam", "1")).resolves.toBe("700000000000000001");
    await expect(resolver.memberId("sam", "1")).resolves.toBe("700000000000000002");
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("prefers an exact username over a partial nickname", async () => {
    // "Bobby" contains "bob", but the member whose username is bob must win.
    const { rest } = fakeRest({
      "/members/search": [
        { user: { id: "700000000000000002", username: "bobby_fan", global_name: null }, nick: "Bobby", roles: [] },
        { user: { id: "700000000000000001", username: "bob", global_name: null }, nick: "Robert", roles: [] },
      ],
    });
    await expect(new Resolver(rest, config()).memberId("bob", "1")).resolves.toBe("700000000000000001");
  });

  it("matches an exact global display name", async () => {
    const { rest } = fakeRest({
      "/members/search": [member("700000000000000001", "xq_17", { global_name: "Dana" })],
    });
    await expect(new Resolver(rest, config()).memberId("dana", "1")).resolves.toBe("700000000000000001");
  });

  it("is ambiguous when several distinct members match exactly", async () => {
    const { rest } = fakeRest({
      "/members/search": [
        member("700000000000000001", "sam_a", { global_name: "Sam" }),
        member("700000000000000002", "sam_b", { global_name: "Sam" }),
      ],
    });
    const error = await toolErrorOf(() => new Resolver(rest, config()).memberId("sam", "1"));

    expect(error.code).toBe("AMBIGUOUS");
    expect(error.hint).toContain("700000000000000001");
    expect(error.hint).toContain("700000000000000002");
  });

  it("still picks a single partial match when no exact name exists", async () => {
    const { rest } = fakeRest({ "/members/search": [member("700000000000000001", "alice")] });
    await expect(new Resolver(rest, config()).memberId("ali", "1")).resolves.toBe("700000000000000001");
  });

  it("requests up to 100 results from the search endpoint", async () => {
    const get = vi.fn(async (_route: string, _params?: unknown) => [] as unknown[]);
    const resolver = new Resolver({ get } as unknown as DiscordRest, config());

    await resolver.member("nobody", "1").catch(() => undefined);

    expect(get.mock.calls[0]?.[1]).toMatchObject({ query: "nobody", limit: 100 });
  });

  it("refuses to guess when a full page of matches has no exact name", async () => {
    const crowd = Array.from({ length: 100 }, (_, i) => member(`7${String(i).padStart(17, "0")}`, `user${i}`));
    const { rest } = fakeRest({ "/members/search": crowd });
    const error = await toolErrorOf(() => new Resolver(rest, config()).memberId("user", "1"));

    expect(error.code).toBe("AMBIGUOUS");
    expect(error.hint).toContain("Too many members match; type more of the name or pass the ID.");
  });

  it("refuses substring matches when exact is requested", async () => {
    const { rest } = fakeRest({ "/members/search": [member("700000000000000001", "alice")] });
    const resolver = new Resolver(rest, config());

    const error = await toolErrorOf(() => resolver.memberId("ali", "1", { exact: true }));
    expect(error.code).toBe("NOT_FOUND");
    expect(error.hint).toContain("Destructive actions need the exact name or the ID.");

    await expect(resolver.memberId("alice", "1", { exact: true })).resolves.toBe("700000000000000001");
  });

  it("does not search for an empty name", async () => {
    const { rest, calls } = fakeRest({ "/members/search": [member("700000000000000001", "alice")] });
    const error = await toolErrorOf(() => new Resolver(rest, config()).member("@", "1"));

    expect(error.code).toBe("NOT_FOUND");
    expect(calls).toHaveLength(0);
  });

  it("rejects role and channel mentions as members", async () => {
    const resolver = new Resolver(fakeRest({}).rest, config());

    expect((await toolErrorOf(() => resolver.member("<@&700000000000000001>", "1"))).code).toBe("INVALID_ARGS");
    expect((await toolErrorOf(() => resolver.member("<#300000000000000001>", "1"))).code).toBe("INVALID_ARGS");
    await expect(resolver.memberId("<@700000000000000001>", "1")).resolves.toBe("700000000000000001");
    await expect(resolver.memberId("<@!700000000000000001>", "1")).resolves.toBe("700000000000000001");
  });
});

describe("exact matching for destructive targets", () => {
  const ROLES = [
    { id: "600000000000000001", name: "Moderators" },
    { id: "600000000000000002", name: "Members" },
  ];

  it("refuses a role substring when exact is requested", async () => {
    const { rest } = fakeRest({ "/roles": ROLES });
    const resolver = new Resolver(rest, config());

    expect(await resolver.roleId("Mod", "1")).toBe("600000000000000001");

    const error = await toolErrorOf(() => resolver.roleId("Mod", "1", { exact: true }));
    expect(error.code).toBe("NOT_FOUND");
    expect(error.hint).toContain("Destructive actions need the exact name or the ID.");
  });

  it("still accepts a normalised exact role name when exact is requested", async () => {
    const { rest } = fakeRest({ "/roles": ROLES });
    await expect(new Resolver(rest, config()).roleId("moderators", "1", { exact: true })).resolves.toBe(
      "600000000000000001",
    );
  });

  it("refuses a channel substring when exact is requested", async () => {
    const { rest } = fakeRest({ "/channels": CHANNELS, "/threads/active": { threads: [] } });
    const resolver = new Resolver(rest, config());

    expect(await resolver.channelId("announcements", "1")).toBe("300000000000000004");

    const error = await toolErrorOf(() => resolver.channelId("announcements", "1", { exact: true }));
    expect(error.code).toBe("NOT_FOUND");
    expect(error.hint).toContain("Destructive actions need the exact name or the ID.");
  });
});

describe("channel versus thread precedence", () => {
  it("lets a thread with the exact name beat a channel that only contains it", async () => {
    const { rest } = fakeRest({
      "/channels": [{ id: "300000000000000010", name: "bug-report-archive", type: 0 }],
      "/threads/active": { threads: [{ id: "400000000000000010", name: "bug-report", type: 11 }] },
    });
    await expect(new Resolver(rest, config()).channelId("bug-report", "1")).resolves.toBe("400000000000000010");
  });

  it("does not fetch threads when a channel matches exactly", async () => {
    const { rest, calls } = fakeRest({ "/channels": CHANNELS, "/threads/active": { threads: [] } });
    await new Resolver(rest, config()).channelId("general", "1");

    expect(calls.some((route) => route.includes("/threads/active"))).toBe(false);
  });
});

describe("gateway cache maintenance", () => {
  it("GUILD_CREATE clears the guild list so a new server resolves by name", async () => {
    let listed: unknown[] = GUILDS;
    const get = vi.fn(async () => listed);
    const resolver = new Resolver({ get } as unknown as DiscordRest, config());

    await resolver.guildId("TestPlace");

    listed = [...GUILDS, { id: "333333333333333333", name: "New Server" }];
    resolver.applyDispatch({
      t: "GUILD_CREATE",
      d: { id: "333333333333333333", name: "New Server", channels: [], roles: [] },
    } as never);

    await expect(resolver.guildId("New Server")).resolves.toBe("333333333333333333");
    expect(get).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["THREAD_LIST_SYNC", { guild_id: "1", threads: [] }],
    ["THREAD_UPDATE", { id: "400000000000000001", guild_id: "1", type: 11, name: "x" }],
  ])("%s drops the cached active-thread listing", async (t, d) => {
    const { rest, calls } = fakeRest({ "/threads/active": { threads: [] } });
    const resolver = new Resolver(rest, config());

    await resolver.threads("1");
    resolver.applyDispatch({ t, d } as never);
    await resolver.threads("1");

    expect(calls.filter((route) => route.includes("/threads/active"))).toHaveLength(2);
  });
});

describe("empty names", () => {
  it("refuses a bare # or @ instead of matching every channel", async () => {
    const { rest } = fakeRest({ "/channels": CHANNELS, "/threads/active": { threads: [] } });
    const resolver = new Resolver(rest, config());

    expect((await toolErrorOf(() => resolver.channelId("#", "1"))).code).toBe("NOT_FOUND");
  });

  it("refuses a bare @ as a role", async () => {
    const { rest } = fakeRest({ "/roles": [{ id: "600000000000000001", name: "Moderators" }] });
    expect((await toolErrorOf(() => new Resolver(rest, config()).roleId("@", "1"))).code).toBe("NOT_FOUND");
  });
});

describe("mention kinds", () => {
  it("roleId rejects a user or channel mention", async () => {
    const resolver = new Resolver(fakeRest({}).rest, config());

    expect((await toolErrorOf(() => resolver.roleId("<@700000000000000001>", "1"))).code).toBe("INVALID_ARGS");
    expect((await toolErrorOf(() => resolver.roleId("<#300000000000000001>", "1"))).code).toBe("INVALID_ARGS");
    await expect(resolver.roleId("<@&600000000000000001>", "1")).resolves.toBe("600000000000000001");
  });

  it("channelId rejects a user mention", async () => {
    const resolver = new Resolver(fakeRest({}).rest, config());
    expect((await toolErrorOf(() => resolver.channelId("<@700000000000000001>", "1"))).code).toBe("INVALID_ARGS");
  });
});

describe("DM channel single-flight", () => {
  it("opens one DM channel for concurrent callers", async () => {
    const post = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { id: "800000000000000001" };
    });
    const resolver = new Resolver({ post } as unknown as DiscordRest, config());

    const ids = await Promise.all(Array.from({ length: 5 }, () => resolver.dmChannel("900000000000000001")));

    expect(ids.every((id) => id === "800000000000000001")).toBe(true);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("does not pin a failed DM open", async () => {
    let attempt = 0;
    const post = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("blip");
      return { id: "800000000000000001" };
    });
    const resolver = new Resolver({ post } as unknown as DiscordRest, config());

    await expect(resolver.dmChannel("900000000000000001")).rejects.toThrow("blip");
    await expect(resolver.dmChannel("900000000000000001")).resolves.toBe("800000000000000001");
    expect(post).toHaveBeenCalledTimes(2);
  });
});

describe("channel guild consistency", () => {
  it("refuses a channel ID already known to belong to another server", async () => {
    const resolver = new Resolver(fakeRest({}).rest, config());
    resolver.upsertChannel("2", { id: "300000000000000009", name: "elsewhere", type: 0 } as never);

    const error = await toolErrorOf(() => resolver.channelId("<#300000000000000009>", "1"));
    expect(error.code).toBe("WRONG_GUILD");
  });

  it("accepts the channel ID for its own server", async () => {
    const resolver = new Resolver(fakeRest({}).rest, config());
    resolver.upsertChannel("1", { id: "300000000000000009", name: "here", type: 0 } as never);

    await expect(resolver.channelId("300000000000000009", "1")).resolves.toBe("300000000000000009");
  });

  it("makes no request for an unknown channel ID", async () => {
    const { rest, calls } = fakeRest({});
    await expect(new Resolver(rest, config()).channelId("300000000000000009", "1")).resolves.toBe(
      "300000000000000009",
    );
    expect(calls).toHaveLength(0);
  });
});
