import { describe, expect, it, vi } from "vitest";
import { PermissionFlagsBits, Routes } from "discord-api-types/v10";
import type { APIChannel } from "discord-api-types/v10";
import { editChannel, deleteChannel, setChannelPermissions } from "../src/tools/channels.js";
import { ToolError } from "../src/lib/errors.js";
import { CHANNEL_PERMISSIONS } from "../src/schemas/permissions.js";
import { config, fakeRest, registryWith } from "./helpers.js";

const GUILD = "100000000000000001";
const CHANNEL = "100000000000000002";
const CATEGORY = "100000000000000003";
const ROLE = "100000000000000004";

/** Resolver stub: IDs pass straight through, and cache hooks are spies. */
function resolverStub() {
  return {
    guildId: async () => GUILD,
    channelGuildId: async () => GUILD,
    channelId: async (input: string) => input,
    roleId: async () => ROLE,
    findChannel: async () => undefined,
    invalidateChannels: vi.fn(),
    invalidateThreads: vi.fn(),
    upsertChannel: vi.fn(),
    removeChannel: vi.fn(),
  };
}

describe("discord_set_channel_permissions merge", () => {
  // KickMembers is a guild-wide bit, not in the curated channel list. A merge
  // must carry it through untouched rather than dropping it.
  const existingOverwrite = {
    id: ROLE,
    type: 0,
    allow: String(PermissionFlagsBits.KickMembers | CHANNEL_PERMISSIONS.ViewChannel),
    deny: String(CHANNEL_PERMISSIONS.SendMessages),
  };

  function setup() {
    const channel = { id: CHANNEL, guild_id: GUILD, type: 0, permission_overwrites: [existingOverwrite] };
    const { rest } = fakeRest({ [`/channels/${CHANNEL}`]: channel });
    const resolver = resolverStub();
    const registry = registryWith([setChannelPermissions], { rest, resolver });
    return { registry, rest };
  }

  it("keeps bits the curated list does not name", async () => {
    const { registry, rest } = setup();
    await registry.run("discord_set_channel_permissions", {
      channel: CHANNEL, target: "Moderator", target_type: "role", allow: ["SendMessages"],
    });

    const body = rest.put.mock.calls[0]?.[1] as { allow: string; deny: string };
    expect(BigInt(body.allow)).toBe(PermissionFlagsBits.KickMembers | CHANNEL_PERMISSIONS.ViewChannel | CHANNEL_PERMISSIONS.SendMessages);
    expect(BigInt(body.deny)).toBe(0n);
  });

  it("moves a bit from allow to deny and back without touching the rest", async () => {
    const { registry, rest } = setup();
    await registry.run("discord_set_channel_permissions", {
      channel: CHANNEL, target: "Moderator", target_type: "role", deny: ["ViewChannel"],
    });

    const body = rest.put.mock.calls[0]?.[1] as { allow: string; deny: string };
    expect(BigInt(body.allow)).toBe(PermissionFlagsBits.KickMembers);
    expect(BigInt(body.deny)).toBe(CHANNEL_PERMISSIONS.SendMessages | CHANNEL_PERMISSIONS.ViewChannel);
  });

  it("reports the resulting overwrite with names decoded from every bit", async () => {
    const { registry } = setup();
    const outcome = await registry.run("discord_set_channel_permissions", {
      channel: CHANNEL, target: "Moderator", target_type: "role", allow: ["SendMessages"],
    });

    expect(outcome.data).toMatchObject({
      allow: expect.arrayContaining(["KickMembers", "ViewChannel", "SendMessages"]),
      deny: [],
    });
  });
});

describe("discord_edit_channel", () => {
  function setup(channel: Partial<APIChannel> = {}, categoryOverwrites: unknown[] = []) {
    const current = { id: CHANNEL, guild_id: GUILD, type: 0, name: "general", ...channel };
    const category = { id: CATEGORY, guild_id: GUILD, type: 4, name: "Staff", permission_overwrites: categoryOverwrites };
    const { rest } = fakeRest({ [`/channels/${CHANNEL}`]: current, [`/channels/${CATEGORY}`]: category });
    const resolver = resolverStub();
    const registry = registryWith([editChannel], { rest, resolver });
    return { registry, rest, resolver };
  }

  it("never sends lock_permissions to the channel PATCH", async () => {
    const { registry, rest } = setup();
    await registry.run("discord_edit_channel", { channel: CHANNEL, name: "renamed", sync_permissions: true, category: CATEGORY });

    const channelPatches = rest.patch.mock.calls.filter((call) => String(call[0]).endsWith(`/channels/${CHANNEL}`));
    for (const [, body] of channelPatches) expect(body).not.toHaveProperty("lock_permissions");
  });

  it("moves with sync through the guild positions route and skips the channel PATCH when nothing else changes", async () => {
    const { registry, rest } = setup();
    await registry.run("discord_edit_channel", { channel: CHANNEL, category: CATEGORY, sync_permissions: true });

    expect(rest.patch).toHaveBeenCalledOnce();
    expect(rest.patch.mock.calls[0]?.[0]).toBe(Routes.guildChannels(GUILD));
    expect(rest.patch.mock.calls[0]?.[1]).toEqual([{ id: CHANNEL, parent_id: CATEGORY, lock_permissions: true }]);
    // The positions route returns nothing, so the channel is fetched for the response.
    expect(rest.get).toHaveBeenCalledWith(Routes.channel(CHANNEL));
  });

  it("sends parent_id on the channel PATCH when the move does not sync", async () => {
    const { registry, rest } = setup();
    await registry.run("discord_edit_channel", { channel: CHANNEL, category: CATEGORY });

    const [route, body] = rest.patch.mock.calls[0] ?? [];
    expect(route).toBe(Routes.channel(CHANNEL));
    expect(body).toMatchObject({ parent_id: CATEGORY });
    expect(body).not.toHaveProperty("lock_permissions");
  });

  it("refuses a sync that would copy an elevated grant from the category", async () => {
    const { registry, rest } = setup({}, [{ id: GUILD, type: 0, allow: PermissionFlagsBits.ManageMessages.toString(), deny: "0" }]);
    const error = (await registry
      .run("discord_edit_channel", { channel: CHANNEL, category: CATEGORY, sync_permissions: true })
      .catch((e: unknown) => e)) as ToolError;

    expect(error.code).toBe("ELEVATED_PERMISSION");
    expect(rest.patch).not.toHaveBeenCalled();
  });

  it("refuses a sync that would replace a private channel's overwrites", async () => {
    const hidden = [{ id: GUILD, type: 0, allow: "0", deny: PermissionFlagsBits.ViewChannel.toString() }];
    const { registry, rest } = setup({ permission_overwrites: hidden } as Partial<APIChannel>);
    const error = (await registry
      .run("discord_edit_channel", { channel: CHANNEL, category: CATEGORY, sync_permissions: true })
      .catch((e: unknown) => e)) as ToolError;

    expect(error.code).toBe("EXPOSES_CHANNEL");
    expect(rest.patch).not.toHaveBeenCalled();
  });

  it("rejects sync_permissions without a category", async () => {
    const { registry, rest } = setup();
    const error = (await registry
      .run("discord_edit_channel", { channel: CHANNEL, sync_permissions: true })
      .catch((e: unknown) => e)) as ToolError;

    expect(error).toBeInstanceOf(ToolError);
    expect(error.code).toBe("MISSING_ARG");
    expect(error.message).toContain("sync_permissions");
    expect(rest.patch).not.toHaveBeenCalled();
  });
});

describe("discord_delete_channel", () => {
  function setup(type: number) {
    const deleted = { id: CATEGORY, guild_id: GUILD, type, name: "Staff" };
    const { rest } = fakeRest({ [`/channels/${CATEGORY}`]: deleted });
    const resolver = resolverStub();
    const registry = registryWith([deleteChannel], { rest, resolver, config: config({ allowDestructive: true }) });
    return { registry, resolver };
  }

  it("invalidates the channel listing when a category is deleted, since its children move", async () => {
    const { registry, resolver } = setup(4); // GuildCategory
    await registry.run("discord_delete_channel", { channel: CATEGORY });

    expect(resolver.invalidateChannels).toHaveBeenCalledWith(GUILD);
    expect(resolver.removeChannel).not.toHaveBeenCalled();
  });

  it("removes just the channel from the cache for any other type", async () => {
    const { registry, resolver } = setup(0); // GuildText
    await registry.run("discord_delete_channel", { channel: CATEGORY });

    expect(resolver.removeChannel).toHaveBeenCalledWith(GUILD, CATEGORY);
    expect(resolver.invalidateChannels).not.toHaveBeenCalled();
  });
});
