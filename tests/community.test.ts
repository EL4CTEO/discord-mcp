import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ChannelType } from "discord-api-types/v10";
import { manageAutomod, manageEmojis, manageInvites, manageScheduledEvents } from "../src/tools/community.js";
import { Resolver } from "../src/discord/resolve.js";
import { config, fakeRest, registryWith } from "./helpers.js";

const GUILD = "100000000000000000";
const VOICE = "200000000000000001";
const MODS = "300000000000000001";
const ROLE_ID = "600000000000000001";
const EVENT_ID = "400000000000000001";
const RULE_ID = "500000000000000001";
const EMOJI_ID = "800000000000000001";

/** Resolver stand-in: names resolve to fixed IDs, everything else is an identity or empty. */
function resolverStub(overrides: Record<string, unknown> = {}) {
  return {
    guildId: vi.fn(async () => GUILD),
    channelId: vi.fn(async (input: string) => (input === "mods" ? MODS : input)),
    findChannel: vi.fn(async () => undefined),
    roleId: vi.fn(async (input: string) => (input === "Moderator" ? ROLE_ID : input)),
    roleNames: vi.fn(async () => new Map([[ROLE_ID, "Moderator"]])),
    channels: vi.fn(async () => []),
    emojis: vi.fn(async () => []),
    invalidate: vi.fn(),
    ...overrides,
  };
}

/** An argument of a recorded mock call. The fake's signatures name only the route, so later arguments are read loosely. */
const argOf = (call: readonly unknown[] | undefined, index: number): unknown => call?.[index];

const EXTERNAL_EVENT = {
  id: EVENT_ID,
  guild_id: GUILD,
  channel_id: null,
  creator_id: "700000000000000001",
  name: "Build night",
  description: "Bring a map",
  scheduled_start_time: "2026-11-01T18:00:00Z",
  scheduled_end_time: "2026-11-01T20:00:00Z",
  privacy_level: 2,
  status: 1,
  entity_type: 3,
  entity_id: null,
  entity_metadata: { location: "Discord" },
  user_count: 7,
};

const KEYWORD_RULE = {
  id: RULE_ID,
  guild_id: GUILD,
  name: "No slurs",
  creator_id: "700000000000000001",
  event_type: 1,
  trigger_type: 1,
  trigger_metadata: { keyword_filter: ["alpha", "beta"] },
  actions: [
    { type: 1, metadata: { custom_message: "nope" } },
    { type: 3, metadata: { duration_seconds: 300 } },
  ],
  enabled: true,
  exempt_roles: [ROLE_ID],
  exempt_channels: [],
};

describe("discord_scheduled_events", () => {
  beforeAll(() => {
    // Pins "now" so the future-start checks do not depend on the day the suite runs.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-14T12:00:00Z"));
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it("list formats each event compactly and asks Discord for the interested count", async () => {
    const { rest, calls } = fakeRest({ "scheduled-events": [EXTERNAL_EVENT] });
    const registry = registryWith([manageScheduledEvents], { rest, resolver: resolverStub() });

    const outcome = await registry.run("discord_scheduled_events", {});

    expect(outcome.summary).toBe(`1 scheduled event in server ${GUILD}.`);
    expect(outcome.data).toEqual([
      {
        id: EVENT_ID,
        name: "Build night",
        status: "scheduled",
        entity: "external",
        start: "2026-11-01T18:00:00Z",
        end: "2026-11-01T20:00:00Z",
        location: "Discord",
        interested: 7,
      },
    ]);
    expect(argOf(rest.get.mock.calls[0], 1)).toEqual({ with_user_count: true });
    expect(calls).toHaveLength(1);
  });

  it("create external sends the right route and body, always GuildOnly", async () => {
    const { rest, calls } = fakeRest({ "scheduled-events": EXTERNAL_EVENT });
    const registry = registryWith([manageScheduledEvents], { rest, resolver: resolverStub() });

    await registry.run("discord_scheduled_events", {
      action: "create",
      name: "Build night",
      start_time: "2026-11-01T18:00:00Z",
      end_time: "2026-11-01T20:00:00Z",
      location: "Discord",
      description: "Bring a map",
    });

    const post = calls.find((c) => c.method === "POST");
    expect(post?.route).toBe(`/guilds/${GUILD}/scheduled-events`);
    expect(post?.body).toEqual({
      name: "Build night",
      privacy_level: 2,
      scheduled_start_time: "2026-11-01T18:00:00Z",
      scheduled_end_time: "2026-11-01T20:00:00Z",
      description: "Bring a map",
      entity_type: 3,
      entity_metadata: { location: "Discord" },
    });
  });

  it("create in a voice channel sets the Voice entity type and channel id, with no metadata", async () => {
    const voiceEvent = { ...EXTERNAL_EVENT, entity_type: 2, channel_id: VOICE, entity_metadata: null };
    const { rest, calls } = fakeRest({ "scheduled-events": voiceEvent });
    const resolver = resolverStub({
      channelId: vi.fn(async () => VOICE),
      findChannel: vi.fn(async () => ({ id: VOICE, name: "Lounge", type: ChannelType.GuildVoice })),
    });
    const registry = registryWith([manageScheduledEvents], { rest, resolver });

    await registry.run("discord_scheduled_events", {
      action: "create",
      name: "Movie night",
      start_time: "2026-11-01T18:00:00Z",
      channel: "Lounge",
    });

    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toEqual({
      name: "Movie night",
      privacy_level: 2,
      scheduled_start_time: "2026-11-01T18:00:00Z",
      entity_type: 2,
      channel_id: VOICE,
    });
    expect((post?.body as Record<string, unknown>).entity_metadata).toBeUndefined();
  });

  it("refuses an external event without end_time before calling Discord", async () => {
    const { rest, calls } = fakeRest({});
    const registry = registryWith([manageScheduledEvents], { rest, resolver: resolverStub() });

    await expect(
      registry.run("discord_scheduled_events", {
        action: "create",
        name: "Build night",
        start_time: "2026-11-01T18:00:00Z",
        location: "Discord",
      }),
    ).rejects.toMatchObject({ code: "MISSING_ARG" });
    expect(calls).toHaveLength(0);
  });

  it("refuses an end time before the start time locally", async () => {
    const { rest, calls } = fakeRest({});
    const registry = registryWith([manageScheduledEvents], { rest, resolver: resolverStub() });

    await expect(
      registry.run("discord_scheduled_events", {
        action: "create",
        name: "Build night",
        start_time: "2026-11-01T18:00:00Z",
        end_time: "2026-11-01T17:00:00Z",
        location: "Discord",
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGS" });
    expect(calls).toHaveLength(0);
  });

  it("delete is refused before any lookup when destructive actions are off", async () => {
    const { rest, calls } = fakeRest({});
    const resolver = resolverStub();
    const registry = registryWith([manageScheduledEvents], {
      rest,
      resolver,
      config: config({ allowDestructive: false }),
    });

    await expect(
      registry.run("discord_scheduled_events", { action: "delete", event: "Build night" }),
    ).rejects.toMatchObject({ code: "DESTRUCTIVE_DISABLED" });
    expect(calls).toHaveLength(0);
    expect(resolver.guildId).not.toHaveBeenCalled();
  });

  it("delete by ID sends one DELETE carrying the audit reason", async () => {
    const { rest, calls } = fakeRest({});
    const registry = registryWith([manageScheduledEvents], {
      rest,
      resolver: resolverStub(),
      config: config({ allowDestructive: true }),
    });

    await registry.run("discord_scheduled_events", { action: "delete", event: EVENT_ID, reason: "cleanup" });

    expect(calls).toEqual([{ method: "DELETE", route: `/guilds/${GUILD}/scheduled-events/${EVENT_ID}` }]);
    expect(argOf(rest.delete.mock.calls[0], 1)).toBe("cleanup");
  });

  it("resolves an event by a normalised name, and refuses a name that matches two events", async () => {
    const twins = [EXTERNAL_EVENT, { ...EXTERNAL_EVENT, id: "400000000000000002", name: "build-night" }];
    const { rest, calls } = fakeRest({ "scheduled-events": [EXTERNAL_EVENT] });
    const registry = registryWith([manageScheduledEvents], {
      rest,
      resolver: resolverStub(),
      config: config({ allowDestructive: true }),
    });

    await registry.run("discord_scheduled_events", { action: "delete", event: "build-night" });
    expect(calls.find((c) => c.method === "DELETE")?.route).toBe(`/guilds/${GUILD}/scheduled-events/${EVENT_ID}`);

    const ambiguous = fakeRest({ "scheduled-events": twins });
    const twin = registryWith([manageScheduledEvents], {
      rest: ambiguous.rest,
      resolver: resolverStub(),
      config: config({ allowDestructive: true }),
    });
    await expect(twin.run("discord_scheduled_events", { action: "delete", event: "Build Night" })).rejects.toMatchObject({
      code: "AMBIGUOUS",
    });
    expect(ambiguous.calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("users pages through interested members and says how to continue", async () => {
    const users = [
      { user: { id: "1", username: "ann" } },
      { user: { id: "2", username: "bo", global_name: "Bo" } },
    ];
    const { rest } = fakeRest({ [`${EVENT_ID}/users`]: users });
    const registry = registryWith([manageScheduledEvents], { rest, resolver: resolverStub() });

    const outcome = await registry.run("discord_scheduled_events", { action: "users", event: EVENT_ID, limit: 2 });

    expect(outcome.summary).toContain('More may follow: pass after="2".');
    expect(outcome.data).toEqual([
      { id: "1", username: "ann" },
      { id: "2", username: "bo", display_name: "Bo" },
    ]);
    expect(argOf(rest.get.mock.calls[0], 1)).toEqual({ limit: 2 });
  });

  it("create refuses a start time in the past before calling Discord", async () => {
    const { rest, calls } = fakeRest({});
    const registry = registryWith([manageScheduledEvents], { rest, resolver: resolverStub() });

    await expect(
      registry.run("discord_scheduled_events", {
        action: "create",
        name: "Old news",
        start_time: "2026-01-01T18:00:00Z",
        end_time: "2026-01-01T20:00:00Z",
        location: "Discord",
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGS" });
    expect(calls).toHaveLength(0);
  });

  it("edit refuses a start time in the past before looking the event up", async () => {
    const { rest, calls } = fakeRest({ [EVENT_ID]: EXTERNAL_EVENT });
    const registry = registryWith([manageScheduledEvents], { rest, resolver: resolverStub() });

    await expect(
      registry.run("discord_scheduled_events", { action: "edit", event: EVENT_ID, start_time: "2026-01-01T18:00:00Z" }),
    ).rejects.toMatchObject({ code: "INVALID_ARGS" });
    expect(calls).toHaveLength(0);
  });

  it("cancelling an event by edit is refused when destructive actions are off, before any lookup", async () => {
    const { rest, calls } = fakeRest({});
    const resolver = resolverStub();
    const registry = registryWith([manageScheduledEvents], { rest, resolver });

    await expect(
      registry.run("discord_scheduled_events", { action: "edit", event: EVENT_ID, status: "canceled" }),
    ).rejects.toMatchObject({ code: "DESTRUCTIVE_DISABLED" });
    expect(calls).toHaveLength(0);
    expect(resolver.guildId).not.toHaveBeenCalled();
  });
});

describe("discord_automod", () => {
  it("list formats rules with trigger, actions and exemptions", async () => {
    const { rest } = fakeRest({ "auto-moderation/rules": [KEYWORD_RULE] });
    const registry = registryWith([manageAutomod], { rest, resolver: resolverStub() });

    const outcome = await registry.run("discord_automod", {});

    expect(outcome.data).toEqual([
      {
        id: RULE_ID,
        name: "No slurs",
        enabled: true,
        trigger: "keyword",
        actions: ["block", "timeout 300s"],
        keywords: ["alpha", "beta"],
        exempt_roles: ["Moderator"],
      },
    ]);
  });

  it("create sends the keyword trigger, actions and exemptions in Discord's shape", async () => {
    const { rest, calls } = fakeRest({ "auto-moderation/rules": KEYWORD_RULE });
    const registry = registryWith([manageAutomod], { rest, resolver: resolverStub() });

    await registry.run("discord_automod", {
      action: "create",
      name: "No slurs",
      trigger: "keyword",
      keywords: ["alpha"],
      actions: [
        { type: "block", custom_message: "nope" },
        { type: "alert", channel: "mods" },
      ],
      exempt_roles: ["Moderator"],
    });

    const post = calls.find((c) => c.method === "POST");
    expect(post?.route).toBe(`/guilds/${GUILD}/auto-moderation/rules`);
    expect(post?.body).toEqual({
      name: "No slurs",
      event_type: 1,
      trigger_type: 1,
      trigger_metadata: { keyword_filter: ["alpha"] },
      actions: [
        { type: 1, metadata: { custom_message: "nope" } },
        { type: 2, metadata: { channel_id: MODS } },
      ],
      enabled: true,
      exempt_roles: [ROLE_ID],
    });
  });

  it("rejects a timeout action on a spam rule locally", async () => {
    const { rest, calls } = fakeRest({});
    const registry = registryWith([manageAutomod], { rest, resolver: resolverStub() });

    await expect(
      registry.run("discord_automod", {
        action: "create",
        name: "Spam guard",
        trigger: "spam",
        actions: [{ type: "timeout", duration_seconds: 300 }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGS" });
    expect(calls).toHaveLength(0);
  });

  it("delete is refused when destructive actions are off, with no REST call", async () => {
    const { rest, calls } = fakeRest({});
    const registry = registryWith([manageAutomod], { rest, resolver: resolverStub() });

    await expect(registry.run("discord_automod", { action: "delete", rule: RULE_ID })).rejects.toMatchObject({
      code: "DESTRUCTIVE_DISABLED",
    });
    expect(calls).toHaveLength(0);
  });

  it("disabling a rule through edit is refused when destructive actions are off", async () => {
    const { rest, calls } = fakeRest({});
    const registry = registryWith([manageAutomod], { rest, resolver: resolverStub() });

    await expect(
      registry.run("discord_automod", { action: "edit", rule: RULE_ID, enabled: false }),
    ).rejects.toMatchObject({ code: "DESTRUCTIVE_DISABLED" });
    expect(calls).toHaveLength(0);
  });

  it("edit merges a keyword change into the existing metadata instead of replacing it", async () => {
    const rule = { ...KEYWORD_RULE, trigger_metadata: { keyword_filter: ["alpha"], allow_list: ["gamma"] } };
    // The rule ID is listed first so the PATCH route answers with the rule itself.
    const { rest, calls } = fakeRest({ [RULE_ID]: rule, "auto-moderation/rules": [rule] });
    const registry = registryWith([manageAutomod], { rest, resolver: resolverStub() });

    await registry.run("discord_automod", { action: "edit", rule: "No slurs", keywords: ["beta"] });

    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.route).toBe(`/guilds/${GUILD}/auto-moderation/rules/${RULE_ID}`);
    expect(patch?.body).toEqual({ trigger_metadata: { keyword_filter: ["beta"], allow_list: ["gamma"] } });
  });

  it("refuses a substring role name in exemptions, since exemptions match exactly", async () => {
    const { rest, calls } = fakeRest({ "/roles": [{ id: ROLE_ID, name: "Moderator" }] });
    const real = new Resolver(rest as never, config());
    const roleId = vi.fn((input: string, guildId: string, options?: { exact?: boolean }) =>
      real.roleId(input, guildId, options),
    );
    const registry = registryWith([manageAutomod], { rest, resolver: resolverStub({ roleId }) });

    await expect(
      registry.run("discord_automod", {
        action: "create",
        name: "Mods only",
        trigger: "keyword",
        keywords: ["alpha"],
        exempt_roles: ["Mod"],
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(roleId).toHaveBeenCalledWith("Mod", GUILD, { exact: true });
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("refuses a substring channel name for an alert action, so alerts cannot reach the wrong channel", async () => {
    const { rest, calls } = fakeRest({ "/channels": [{ id: MODS, name: "mods", type: ChannelType.GuildText }] });
    const real = new Resolver(rest as never, config());
    const registry = registryWith([manageAutomod], {
      rest,
      resolver: resolverStub({ channelId: real.channelId.bind(real) }),
    });

    await expect(
      registry.run("discord_automod", {
        action: "create",
        name: "Alerts",
        trigger: "keyword",
        keywords: ["alpha"],
        actions: [{ type: "alert", channel: "mod" }],
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("refuses to exempt @everyone, which would exempt every member", async () => {
    const { rest, calls } = fakeRest({});
    const registry = registryWith([manageAutomod], { rest, resolver: resolverStub() });

    await expect(
      registry.run("discord_automod", {
        action: "create",
        name: "Everyone exempt",
        trigger: "keyword",
        keywords: ["alpha"],
        exempt_roles: [GUILD],
      }),
    ).rejects.toMatchObject({ code: "DESTRUCTIVE_DISABLED" });
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("refuses an edit that replaces block and timeout with an alert, and allows it when destructive actions are on", async () => {
    const routes = { [RULE_ID]: KEYWORD_RULE, "auto-moderation/rules": [KEYWORD_RULE] };
    const alertOnly = [{ type: "alert" as const, channel: "mods" }];

    const refused = fakeRest(routes);
    await expect(
      registryWith([manageAutomod], { rest: refused.rest, resolver: resolverStub() }).run("discord_automod", {
        action: "edit",
        rule: "No slurs",
        actions: alertOnly,
      }),
    ).rejects.toMatchObject({ code: "DESTRUCTIVE_DISABLED" });
    expect(refused.calls.some((c) => c.method === "PATCH")).toBe(false);

    const allowed = fakeRest(routes);
    await registryWith([manageAutomod], {
      rest: allowed.rest,
      resolver: resolverStub(),
      config: config({ allowDestructive: true }),
    }).run("discord_automod", { action: "edit", rule: "No slurs", actions: alertOnly });
    expect(allowed.calls.some((c) => c.method === "PATCH")).toBe(true);
  });

  it("refuses an edit that empties a keyword rule's filter", async () => {
    const { rest, calls } = fakeRest({ "auto-moderation/rules": [KEYWORD_RULE] });
    const registry = registryWith([manageAutomod], { rest, resolver: resolverStub() });

    await expect(
      registry.run("discord_automod", { action: "edit", rule: "No slurs", keywords: [] }),
    ).rejects.toMatchObject({ code: "DESTRUCTIVE_DISABLED" });
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });
});

describe("discord_manage_emojis", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "dmcp-emoji-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("list formats emojis with a ready-to-send mention and role names", async () => {
    const { rest } = fakeRest({});
    const resolver = resolverStub({
      emojis: vi.fn(async () => [{ id: EMOJI_ID, name: "party", animated: true, roles: [ROLE_ID] }]),
    });
    const registry = registryWith([manageEmojis], { rest, resolver });

    const outcome = await registry.run("discord_manage_emojis", {});

    expect(outcome.data).toEqual([
      { id: EMOJI_ID, name: "party", animated: true, mention: `<a:party:${EMOJI_ID}>`, roles: ["Moderator"] },
    ]);
  });

  it("refuses a 300 KiB file by its size on disk, before reading it, with FILE_TOO_LARGE", async () => {
    const path = join(dir, "huge.png");
    await writeFile(path, Buffer.alloc(300 * 1024));
    const { rest, calls } = fakeRest({});
    const registry = registryWith([manageEmojis], {
      rest,
      resolver: resolverStub(),
      config: config({ uploadDirs: undefined }),
    });

    await expect(
      registry.run("discord_manage_emojis", { action: "create", name: "huge_one", file: { path } }),
    ).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    expect(calls).toHaveLength(0);
  });

  it("create sends a data URI with the image type from the extension, then invalidates the emoji cache", async () => {
    const bytes = Buffer.from("GIF89a-test-bytes");
    const path = join(dir, "wave.gif");
    await writeFile(path, bytes);
    const { rest, calls } = fakeRest({ "/emojis": { id: EMOJI_ID, name: "wave", animated: true } });
    const resolver = resolverStub();
    const registry = registryWith([manageEmojis], { rest, resolver, config: config({ uploadDirs: undefined }) });

    await registry.run("discord_manage_emojis", { action: "create", name: "wave", file: { path }, roles: ["Moderator"] });

    const post = calls.find((c) => c.method === "POST");
    expect(post?.route).toBe(`/guilds/${GUILD}/emojis`);
    expect(post?.body).toEqual({
      name: "wave",
      image: `data:image/gif;base64,${bytes.toString("base64")}`,
      roles: [ROLE_ID],
    });
    expect(resolver.invalidate).toHaveBeenCalledWith(GUILD);
  });

  it("delete is refused when destructive actions are off", async () => {
    const { rest, calls } = fakeRest({});
    const registry = registryWith([manageEmojis], { rest, resolver: resolverStub() });

    await expect(registry.run("discord_manage_emojis", { action: "delete", emoji: "party" })).rejects.toMatchObject({
      code: "DESTRUCTIVE_DISABLED",
    });
    expect(calls).toHaveLength(0);
  });

  it("delete finds the emoji by name regardless of case", async () => {
    const { rest, calls } = fakeRest({});
    const resolver = resolverStub({ emojis: vi.fn(async () => [{ id: EMOJI_ID, name: "party" }]) });
    const registry = registryWith([manageEmojis], {
      rest,
      resolver,
      config: config({ allowDestructive: true }),
    });

    await registry.run("discord_manage_emojis", { action: "delete", emoji: "PARTY" });

    expect(calls.find((c) => c.method === "DELETE")?.route).toBe(`/guilds/${GUILD}/emojis/${EMOJI_ID}`);
    expect(resolver.invalidate).toHaveBeenCalledWith(GUILD);
  });
});

describe("discord_manage_invites", () => {
  const INVITE = {
    code: "abc-123",
    channel: { id: VOICE, name: "general", type: ChannelType.GuildText },
    inviter: { id: "700000000000000001", username: "Daniele" },
    uses: 3,
    max_uses: 0,
    max_age: 0,
    temporary: false,
    expires_at: null,
    type: 0,
  };

  it("list shows each invite's link, channel, inviter and uses", async () => {
    const { rest } = fakeRest({ "/invites": [INVITE] });
    const registry = registryWith([manageInvites], { rest, resolver: resolverStub() });

    const outcome = await registry.run("discord_manage_invites", {});

    expect(outcome.data).toEqual([
      {
        code: "abc-123",
        url: "https://discord.gg/abc-123",
        channel: "general",
        inviter: "Daniele",
        uses: 3,
        max_uses: 0,
      },
    ]);
  });

  it("revoke accepts a full discord.gg link and deletes the matching invite route", async () => {
    const { rest, calls } = fakeRest({});
    const registry = registryWith([manageInvites], {
      rest,
      resolver: resolverStub(),
      config: config({ allowDestructive: true }),
    });

    await registry.run("discord_manage_invites", { action: "revoke", code: "https://discord.gg/abc-123" });

    expect(calls).toEqual([{ method: "DELETE", route: "/invites/abc-123" }]);
  });

  it("revoke also reads discord.com/invite links", async () => {
    const { rest, calls } = fakeRest({});
    const registry = registryWith([manageInvites], {
      rest,
      resolver: resolverStub(),
      config: config({ allowDestructive: true }),
    });

    await registry.run("discord_manage_invites", { action: "revoke", code: "https://discord.com/invite/xyz?event=1" });

    expect(calls).toEqual([{ method: "DELETE", route: "/invites/xyz" }]);
  });

  it("revoke is refused when destructive actions are off, with no REST call", async () => {
    const { rest, calls } = fakeRest({});
    const registry = registryWith([manageInvites], { rest, resolver: resolverStub() });

    await expect(
      registry.run("discord_manage_invites", { action: "revoke", code: "abc-123" }),
    ).rejects.toMatchObject({ code: "DESTRUCTIVE_DISABLED" });
    expect(calls).toHaveLength(0);
  });

  it("revoke rejects a value that is not an invite code, before any request", async () => {
    const { rest, calls } = fakeRest({});
    const registry = registryWith([manageInvites], {
      rest,
      resolver: resolverStub(),
      config: config({ allowDestructive: true }),
    });

    await expect(
      registry.run("discord_manage_invites", { action: "revoke", code: "not a code!" }),
    ).rejects.toMatchObject({ code: "INVALID_ARGS" });
    expect(calls).toHaveLength(0);
  });
});
