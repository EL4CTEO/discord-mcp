import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTool, effectiveSchema } from "../src/tools/registry.js";
import type { ToolError } from "../src/lib/errors.js";
import { manageMemberRoles } from "../src/tools/members.js";
import { deleteMessage, sendMessage } from "../src/tools/messages.js";
import { reorderChannels, setChannelPermissions } from "../src/tools/channels.js";
import { CHANNEL_PERMISSIONS } from "../src/schemas/permissions.js";
import { config, fakeRest, registryWith, snowflakeAged } from "./helpers.js";

const GUILD = "100000000000000000";
const USER = "200000000000000000";
const CHANNEL = "300000000000000000";

const resolver = {
  guildId: async () => GUILD,
  channelId: async (input: string) => input,
  roleId: async (input: string) => `role-${input}`,
  roles: async () => [],
  member: async () => ({ id: USER, member: { user: { id: USER }, roles: ["role-Old"] } }),
  memberId: async () => USER,
  channelGuildId: async () => GUILD,
  invalidateChannels: () => undefined,
};

describe("discord_manage_member_roles", () => {
  it("collapses several changes into one PATCH of the role list", async () => {
    const { rest, calls } = fakeRest();
    await registryWith([manageMemberRoles], { rest, resolver }).run("discord_manage_member_roles", {
      member: "alice",
      add: ["A", "B"],
      remove: ["Old"],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("PATCH");
    expect(new Set((calls[0]?.body as { roles: string[] }).roles)).toEqual(new Set(["role-A", "role-B"]));
  });

  it("uses the single-role endpoint for one change", async () => {
    const { rest, calls } = fakeRest();
    await registryWith([manageMemberRoles], { rest, resolver }).run("discord_manage_member_roles", {
      member: "alice",
      add: ["A"],
    });
    expect(calls.map((c) => c.method)).toEqual(["PUT"]);
    expect(calls[0]?.route).toContain("/roles/role-A");
  });
});

describe("discord_delete_message with an array", () => {
  it("deletes recent messages through the bulk endpoint and old ones individually", async () => {
    const { rest, calls } = fakeRest();
    const recent = [snowflakeAged(60_000), snowflakeAged(120_000)];
    const old = snowflakeAged(20 * 24 * 3600 * 1000);

    const outcome = await registryWith([deleteMessage], {
      rest,
      resolver,
      config: config({ allowDestructive: true }),
    }).run("discord_delete_message", { channel: CHANNEL, message_id: [...recent, old] });

    expect(outcome.summary).toContain("3 succeeded");
    const bulk = calls.filter((c) => c.route.endsWith("/bulk-delete"));
    expect(bulk).toHaveLength(1);
    expect((bulk[0]?.body as { messages: string[] }).messages).toEqual(recent);
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.route)).toEqual([
      `/channels/${CHANNEL}/messages/${old}`,
    ]);
  });
});

describe("discord_send_message", () => {
  it("splits long text into several messages, replying only with the first", async () => {
    let n = 0;
    const { rest, calls } = fakeRest({
      "/messages": () => ({
        id: `50000000000000000${n++}`,
        author: { id: USER, username: "bot" },
        content: "",
        timestamp: "2026-01-01T00:00:00Z",
        attachments: [],
        embeds: [],
        type: 0,
      }),
    });

    const outcome = await registryWith([sendMessage], { rest, resolver }).run("discord_send_message", {
      channel: CHANNEL,
      content: `${"a".repeat(1500)}\n\n${"b".repeat(1500)}`,
      reply_to: "400000000000000000",
    });

    expect(calls).toHaveLength(2);
    expect((calls[0]?.body as { message_reference?: unknown }).message_reference).toBeDefined();
    expect((calls[1]?.body as { message_reference?: unknown }).message_reference).toBeUndefined();
    expect(outcome.summary).toContain("2 messages");
  });

  it("refuses an empty message before calling Discord", async () => {
    const { rest, calls } = fakeRest();
    const error = (await registryWith([sendMessage], { rest, resolver })
      .run("discord_send_message", { channel: CHANNEL })
      .catch((e: unknown) => e)) as ToolError;
    expect(error.code).toBe("EMPTY_MESSAGE");
    expect(calls).toHaveLength(0);
  });
});

describe("discord_reorder_channels", () => {
  const channels = [
    { id: "a", name: "a", type: 0, position: 0, parent_id: "cat" },
    { id: "b", name: "b", type: 0, position: 1, parent_id: "cat" },
    { id: "c", name: "c", type: 0, position: 2, parent_id: "cat" },
    { id: "d", name: "d", type: 0, position: 3, parent_id: "cat" },
    { id: "cat", name: "cat", type: 4, position: 0 },
  ];

  it("fills the listed channels' slots and leaves the others in place", async () => {
    const { rest, calls } = fakeRest();
    await registryWith([reorderChannels], {
      rest,
      resolver: { ...resolver, channels: async () => channels },
    }).run("discord_reorder_channels", { order: ["d", "b"] });

    // b and d swap; a and c keep their positions and are not resent.
    expect(calls[0]?.body).toEqual([
      { id: "d", position: 1 },
      { id: "b", position: 3 },
    ]);
  });

  it("rejects channels from different categories", async () => {
    const mixed = [...channels, { id: "e", name: "e", type: 0, position: 0, parent_id: "other" }];
    const error = (await registryWith([reorderChannels], {
      rest: fakeRest().rest,
      resolver: { ...resolver, channels: async () => mixed },
    })
      .run("discord_reorder_channels", { order: ["a", "e"] })
      .catch((e: unknown) => e)) as ToolError;
    expect(error.code).toBe("MIXED_SCOPE");
  });
});

describe("discord_set_channel_permissions merge mode", () => {
  it("keeps existing grants it was not asked to change", async () => {
    const existing = {
      id: CHANNEL,
      type: 0,
      permission_overwrites: [
        {
          id: "role-Mods",
          type: 0,
          allow: String(CHANNEL_PERMISSIONS.ViewChannel | CHANNEL_PERMISSIONS.AttachFiles),
          deny: "0",
        },
      ],
    };
    const { rest, calls } = fakeRest({ [`/channels/${CHANNEL}`]: existing });

    await registryWith([setChannelPermissions], { rest, resolver }).run("discord_set_channel_permissions", {
      channel: CHANNEL,
      target: "Mods",
      target_type: "role",
      allow: ["SendMessages"],
      deny: ["AttachFiles"],
    });

    const put = calls.find((c) => c.method === "PUT");
    const body = put?.body as { allow: string; deny: string };
    expect(BigInt(body.allow)).toBe(CHANNEL_PERMISSIONS.ViewChannel | CHANNEL_PERMISSIONS.SendMessages);
    expect(BigInt(body.deny)).toBe(CHANNEL_PERMISSIONS.AttachFiles);
  });
});

describe("registry bulk mechanics", () => {
  const seen: string[] = [];
  const multi = defineTool({
    name: "multi",
    title: "Multi",
    description: "Two bulk args.",
    bulkArgs: ["a", "b"],
    inputSchema: { a: z.string(), b: z.string().optional() },
    async handler(args) {
      seen.push(`${args.a}/${args.b ?? ""}`);
      return { summary: "ok" };
    },
  });

  it("refuses two arrays at once", async () => {
    const error = (await registryWith([multi])
      .run("multi", { a: ["1", "2"], b: ["x", "y"] })
      .catch((e: unknown) => e)) as ToolError;
    expect(error.code).toBe("INVALID_ARGS");
  });

  it("widens an optional bulk argument while keeping it optional", async () => {
    seen.length = 0;
    await registryWith([multi]).run("multi", { a: "1", b: ["x", "y"] });
    await registryWith([multi]).run("multi", { a: "2" });
    expect(seen.sort()).toEqual(["1/x", "1/y", "2/"]);
    expect(z.object(effectiveSchema(multi)).safeParse({ a: "3" }).success).toBe(true);
  });

  it("reports progress per item", async () => {
    const progress: number[] = [];
    await registryWith([multi]).run("multi", { a: ["1", "2", "3"] }, { progress: (done) => progress.push(done) });
    expect(progress).toEqual([1, 2, 3]);
  });

  it("prefers a tool's own bulk handler", async () => {
    const fast = defineTool({
      name: "fast",
      title: "Fast",
      description: "Has a bulk endpoint.",
      bulkArgs: ["id"],
      inputSchema: { id: z.string() },
      async bulkHandler(_args, _arg, ids) {
        return ids.map((id) => ({ value: id, ok: true, summary: "bulk" }));
      },
      async handler() {
        throw new Error("per-item path should not run");
      },
    });
    const outcome = await registryWith([fast]).run("fast", { id: ["1", "2"] });
    expect(outcome.summary).toContain("2 succeeded");
  });

  it("skips unstarted items after cancellation", async () => {
    const controller = new AbortController();
    const slow = defineTool({
      name: "slow",
      title: "Slow",
      description: "Cancels itself.",
      bulkArgs: ["id"],
      inputSchema: { id: z.string() },
      async handler() {
        controller.abort();
        return { summary: "ran" };
      },
    });
    const outcome = await registryWith([slow], { config: config({ batchConcurrency: 1 }) }).run(
      "slow",
      { id: ["1", "2", "3"] },
      { signal: controller.signal },
    );
    const rows = outcome.data as Array<{ ok: boolean; error?: string }>;
    expect(rows.filter((r) => r.ok)).toHaveLength(1);
    expect(rows[2]?.error).toContain("cancelled");
  });
});
