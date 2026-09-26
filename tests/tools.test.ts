import { describe, expect, it, vi } from "vitest";
import { DiscordAPIError } from "@discordjs/rest";
import { defineTool, ToolRegistry } from "../src/tools/registry.js";
import { editMember } from "../src/tools/members.js";
import { setChannelPermissions } from "../src/tools/channels.js";
import { CHANNEL_PERMISSIONS, toBitfield } from "../src/schemas/permissions.js";
import { ToolError } from "../src/lib/errors.js";
import { config } from "./helpers.js";


const BOT = "999999999999999999";
const HUMAN = "111111111111111111";

/** Captures which route a mutation was sent to. */
function harness(selfId = BOT) {
  const patch = vi.fn(async (_route: string, _body?: unknown, _reason?: string) => ({
    user: { id: selfId, username: "Assistant" },
    roles: [] as string[],
    nick: null,
  }));
  const resolver = {
    guildId: async () => "guild1",
    memberId: async (input: string) => (input === "Assistant" ? BOT : HUMAN),
    roleNames: async () => new Map<string, string>(),
    selfId: async () => selfId,
    channelId: async () => "chan1",
  };
  const registry = new ToolRegistry({
    config: config(),
    rest: { patch } as never,
    resolver: resolver as never,
    gateway: {} as never,
  }).add(editMember);
  return { registry, patch };
}

describe("discord_edit_member", () => {
  it("renames the bot itself through the @me route", async () => {
    // The normal member route needs a role above the target, which a bot can
    // never have over itself; Discord gates self-rename on @me instead.
    const { registry, patch } = harness();
    await registry.run("discord_edit_member", { member: "Assistant", nickname: "QA Bot" });

    expect(patch).toHaveBeenCalledOnce();
    // discord-api-types percent-encodes the path segment; Discord decodes it.
    expect(decodeURIComponent(String(patch.mock.calls[0]?.[0]))).toContain("/members/@me");
    expect(patch.mock.calls[0]?.[1]).toEqual({ nick: "QA Bot" });
  });

  it("uses the normal member route for anyone else", async () => {
    const { registry, patch } = harness();
    await registry.run("discord_edit_member", { member: "someone", nickname: "Renamed" });

    expect(patch.mock.calls[0]?.[0]).toContain(`/members/${HUMAN}`);
    expect(decodeURIComponent(String(patch.mock.calls[0]?.[0]))).not.toContain("@me");
  });

  it("uses the normal route when voice fields are involved, even for itself", async () => {
    // @me only accepts a nickname, so a mute/deafen must not be routed there.
    const { registry, patch } = harness();
    await registry.run("discord_edit_member", { member: "Assistant", nickname: "X", mute: true });

    expect(decodeURIComponent(String(patch.mock.calls[0]?.[0]))).not.toContain("@me");
  });
});

describe("per-tool missing-permission hints", () => {
  const denied = defineTool({
    name: "denied",
    title: "Denied",
    description: "Always 50013.",
    inputSchema: {},
    missingPermissionHint: "Needs the Pin Messages permission specifically.",
    async handler() {
      throw new DiscordAPIError({ code: 50013, message: "Missing Permissions" }, 50013, 403, "PUT", "https://x", {});
    },
  });

  const generic = defineTool({
    name: "generic",
    title: "Generic",
    description: "Always 50013, no hint override.",
    inputSchema: {},
    async handler() {
      throw new DiscordAPIError({ code: 50013, message: "Missing Permissions" }, 50013, 403, "PUT", "https://x", {});
    },
  });

  const registry = () =>
    new ToolRegistry({ config: config(), rest: {} as never, resolver: {} as never, gateway: {} as never })
      .add(denied, generic);

  it("replaces the generic advice with the tool's own", async () => {
    const error = (await registry().run("denied", {}).catch((e: unknown) => e)) as ToolError;
    expect(error.hint).toBe("Needs the Pin Messages permission specifically.");
  });

  it("falls back to the generic advice when a tool declares none", async () => {
    const error = (await registry().run("generic", {}).catch((e: unknown) => e)) as ToolError;
    expect(error.hint).toContain("ABOVE the target user");
  });

  it("leaves other error codes untouched", async () => {
    const other = defineTool({
      name: "other", title: "Other", description: "404s.", inputSchema: {},
      missingPermissionHint: "should not appear",
      async handler() {
        throw new DiscordAPIError({ code: 10003, message: "Unknown Channel" }, 10003, 404, "GET", "https://x", {});
      },
    });
    const reg = new ToolRegistry({ config: config(), rest: {} as never, resolver: {} as never, gateway: {} as never }).add(other);
    const error = (await reg.run("other", {}).catch((e: unknown) => e)) as ToolError;
    expect(error.hint).toContain("discord_list_channels");
  });
});

describe("discord_set_channel_permissions", () => {
  it("combines permission names into the bitfield Discord expects", () => {
    expect(toBitfield(["ViewChannel"])).toBe(String(CHANNEL_PERMISSIONS.ViewChannel));
    expect(toBitfield(["ViewChannel", "SendMessages"])).toBe(
      String(CHANNEL_PERMISSIONS.ViewChannel | CHANNEL_PERMISSIONS.SendMessages),
    );
  });

  it("treats an empty or missing list as no bits", () => {
    expect(toBitfield([])).toBe("0");
    expect(toBitfield(undefined)).toBe("0");
  });

  it("is order-independent", () => {
    expect(toBitfield(["SendMessages", "ViewChannel"])).toBe(toBitfield(["ViewChannel", "SendMessages"]));
  });

  it("rejects a permission listed in both allow and deny", async () => {
    const registry = new ToolRegistry({
      config: config(),
      rest: {} as never,
      resolver: { guildId: async () => "g", channelId: async () => "c", roleId: async () => "r" } as never,
      gateway: {} as never,
    }).add(setChannelPermissions);

    const error = (await registry
      .run("discord_set_channel_permissions", {
        channel: "general", target: "@everyone",
        allow: ["SendMessages"], deny: ["SendMessages"],
      })
      .catch((e: unknown) => e)) as ToolError;

    expect(error.code).toBe("CONFLICTING_ARGS");
    expect(error.message).toContain("SendMessages");
  });

  it("requires at least one permission to act on", async () => {
    const registry = new ToolRegistry({
      config: config(), rest: {} as never,
      resolver: { guildId: async () => "g", channelId: async () => "c", roleId: async () => "r" } as never,
      gateway: {} as never,
    }).add(setChannelPermissions);

    const error = (await registry
      .run("discord_set_channel_permissions", { channel: "general", target: "@everyone" })
      .catch((e: unknown) => e)) as ToolError;

    expect(error.code).toBe("MISSING_ARG");
  });
});
