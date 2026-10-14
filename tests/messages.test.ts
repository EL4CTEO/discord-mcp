import { describe, expect, it } from "vitest";
import { DiscordAPIError } from "@discordjs/rest";
import { MessageReferenceType } from "discord-api-types/v10";
import type { APIMessage } from "discord-api-types/v10";
import type { ToolError } from "../src/lib/errors.js";
import { formatMessage } from "../src/lib/format.js";
import { deleteMessage, managePoll, readMessages, searchMessages, sendMessage } from "../src/tools/messages.js";
import { config, fakeRest, registryWith, snowflakeAged } from "./helpers.js";

const GUILD = "100000000000000000";
const CHANNEL = "300000000000000000";
const SOURCE = "310000000000000000";
const MESSAGE = "400000000000000000";

const resolver = {
  guildId: async () => GUILD,
  channelId: async (input: string) => input,
  channelGuildId: async () => null,
  emojis: async () => [],
};

/** A minimal message as Discord returns it; extra fields are merged over the defaults. */
function message(id: string, extra: Record<string, unknown> = {}): APIMessage {
  return {
    id,
    author: { id: "200000000000000000", username: "bot" },
    content: "",
    timestamp: "2026-01-01T00:00:00.000Z",
    attachments: [],
    embeds: [],
    type: 0,
    ...extra,
  } as unknown as APIMessage;
}

describe("discord_send_message partial sends", () => {
  it("reports the ids already sent instead of losing them", async () => {
    let calls = 0;
    const { rest, calls: log } = fakeRest({
      "/messages": () => {
        calls += 1;
        if (calls === 2) throw new Error("upstream exploded");
        return message("500000000000000001");
      },
    });

    const error = (await registryWith([sendMessage], { rest, resolver })
      .run("discord_send_message", {
        channel: CHANNEL,
        content: `${"a".repeat(1500)}\n\n${"b".repeat(1500)}`,
      })
      .catch((e: unknown) => e)) as ToolError;

    expect(error.code).toBe("PARTIAL_SEND");
    expect(error.message).toContain("Sent 1 of 2 parts");
    expect(error.message).toContain("upstream exploded");
    expect(error.message).toContain("500000000000000001");
    expect(error.hint).toContain("remaining text");
    expect(log).toHaveLength(2);
  });

  it("rethrows when the first part fails, since nothing was sent", async () => {
    const { rest } = fakeRest({ "/messages": new Error("upstream exploded") });

    const error = (await registryWith([sendMessage], { rest, resolver })
      .run("discord_send_message", { channel: CHANNEL, content: "hello" })
      .catch((e: unknown) => e)) as ToolError;

    expect(error.code).not.toBe("PARTIAL_SEND");
    expect(error.message).toContain("upstream exploded");
  });
});

describe("discord_send_message forward", () => {
  it("sends a forward reference and nothing else", async () => {
    const { rest, calls } = fakeRest({ "/messages": message("500000000000000002") });

    await registryWith([sendMessage], { rest, resolver }).run("discord_send_message", {
      channel: CHANNEL,
      forward: { channel: SOURCE, message_id: MESSAGE },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({
      message_reference: { type: MessageReferenceType.Forward, message_id: MESSAGE, channel_id: SOURCE },
    });
  });

  it("refuses content alongside a forward before calling Discord", async () => {
    const { rest, calls } = fakeRest();

    const error = (await registryWith([sendMessage], { rest, resolver })
      .run("discord_send_message", {
        channel: CHANNEL,
        content: "look at this",
        forward: { channel: SOURCE, message_id: MESSAGE },
      })
      .catch((e: unknown) => e)) as ToolError;

    expect(error.code).toBe("CONFLICTING_ARGS");
    expect(calls).toHaveLength(0);
  });
});

describe("discord_send_message embeds", () => {
  it("rejects suppress_embeds together with embeds", async () => {
    const { rest, calls } = fakeRest();

    const error = (await registryWith([sendMessage], { rest, resolver })
      .run("discord_send_message", {
        channel: CHANNEL,
        content: "hi",
        suppress_embeds: true,
        embeds: [{ title: "Status" }],
      })
      .catch((e: unknown) => e)) as ToolError;

    expect(error.code).toBe("CONFLICTING_ARGS");
    expect(calls).toHaveLength(0);
  });

  it("rejects embeds whose combined text exceeds 6000 characters", async () => {
    const { rest, calls } = fakeRest();

    const error = (await registryWith([sendMessage], { rest, resolver })
      .run("discord_send_message", {
        channel: CHANNEL,
        embeds: [{ description: "x".repeat(3500) }, { description: "y".repeat(3500) }],
      })
      .catch((e: unknown) => e)) as ToolError;

    expect(error.code).toBe("INVALID_ARGS");
    expect(error.message).toContain("Embeds total 7000");
    expect(calls).toHaveLength(0);
  });

  it("accepts embeds that total exactly 6000 characters", async () => {
    const { rest, calls } = fakeRest({ "/messages": message("500000000000000003") });

    await registryWith([sendMessage], { rest, resolver }).run("discord_send_message", {
      channel: CHANNEL,
      embeds: [{ description: "x".repeat(3000) }, { description: "y".repeat(3000) }],
    });

    expect(calls).toHaveLength(1);
  });
});

describe("formatMessage", () => {
  it("shows a forwarded message's snapshot and marks it forwarded", () => {
    const forward = message("500000000000000004", {
      message_reference: { type: MessageReferenceType.Forward, message_id: MESSAGE, channel_id: SOURCE },
      message_snapshots: [
        {
          message: {
            content: "original text",
            attachments: [{ filename: "a.png", url: "https://cdn.example/a.png", size: 12 }],
            embeds: [],
            timestamp: "2025-12-31T00:00:00.000Z",
            type: 0,
          },
        },
      ],
    });

    const out = formatMessage(forward);

    expect(out.content).toBe("original text");
    expect(out.attachments).toEqual([{ name: "a.png", url: "https://cdn.example/a.png", size: 12 }]);
    expect(out.forwarded).toBe(true);
    expect(out.forwarded_from).toEqual({ channel_id: SOURCE, message_id: MESSAGE });
    expect(out.reply_to).toBeUndefined();
  });

  it("formats a poll with vote counts once Discord reports them", () => {
    const out = formatMessage(
      message("500000000000000005", {
        poll: {
          question: { text: "Pizza?" },
          answers: [
            { answer_id: 1, poll_media: { text: "Yes" } },
            { answer_id: 2, poll_media: { text: "No" } },
          ],
          expiry: "2026-12-01T00:00:00.000Z",
          allow_multiselect: false,
          layout_type: 1,
          results: {
            is_finalized: false,
            answer_counts: [
              { id: 1, count: 3, me_voted: false },
              { id: 2, count: 1, me_voted: false },
            ],
          },
        },
      }),
    );

    expect(out.poll).toEqual({
      question: "Pizza?",
      answers: [
        { id: 1, text: "Yes", votes: 3 },
        { id: 2, text: "No", votes: 1 },
      ],
      expires_at: "2026-12-01T00:00:00.000Z",
      finalized: false,
    });
  });

  it("keeps a few fields for an embed that has only fields", () => {
    const fields = Array.from({ length: 7 }, (_, i) => ({ name: `f${i}`, value: "v".repeat(300) }));
    const out = formatMessage(message("500000000000000006", { embeds: [{ fields }] }));

    expect(out.embeds).toEqual([
      { fields: fields.slice(0, 5).map((f) => ({ name: f.name, value: "v".repeat(199) + "…" })) },
    ]);
  });
});

describe("discord_manage_poll", () => {
  it("ends a poll through the expire route", async () => {
    const { rest, calls } = fakeRest({ "/expire": message(MESSAGE) });

    await registryWith([managePoll], { rest, resolver }).run("discord_manage_poll", {
      channel: CHANNEL,
      message_id: MESSAGE,
      action: "end",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.route).toBe(`/channels/${CHANNEL}/polls/${MESSAGE}/expire`);
  });
});

describe("discord_delete_message bulk failures", () => {
  const recent = [snowflakeAged(60_000), snowflakeAged(120_000)];

  it("does not retry id by id when Discord refuses the whole chunk", async () => {
    const denied = new DiscordAPIError(
      { code: 50013, message: "Missing Permissions" },
      50013,
      403,
      "POST",
      "https://x",
      {},
    );
    const { rest, calls } = fakeRest({ "/bulk-delete": denied });

    const outcome = await registryWith([deleteMessage], {
      rest,
      resolver,
      config: config({ allowDestructive: true }),
    }).run("discord_delete_message", { channel: CHANNEL, message_id: recent });

    expect(outcome.summary).toContain("0 succeeded");
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
    const rows = outcome.data as Array<{ ok: boolean; error?: string }>;
    expect(rows.every((r) => !r.ok && r.error?.includes("Missing Permissions"))).toBe(true);
  });

  it("retries id by id when Discord names an id as invalid", async () => {
    const bad = new DiscordAPIError(
      { code: 10008, message: "Unknown Message" },
      10008,
      404,
      "POST",
      "https://x",
      {},
    );
    const { rest, calls } = fakeRest({ "/bulk-delete": bad });

    const outcome = await registryWith([deleteMessage], {
      rest,
      resolver,
      config: config({ allowDestructive: true }),
    }).run("discord_delete_message", { channel: CHANNEL, message_id: recent });

    expect(outcome.summary).toContain("2 succeeded");
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.route)).toEqual([
      `/channels/${CHANNEL}/messages/${recent[0]}`,
      `/channels/${CHANNEL}/messages/${recent[1]}`,
    ]);
  });
});

describe("discord_read_messages around", () => {
  it("rejects a limit above 100 combined with around", async () => {
    const { rest, calls } = fakeRest();

    const error = (await registryWith([readMessages], { rest, resolver })
      .run("discord_read_messages", { channel: CHANNEL, around: MESSAGE, limit: 200 })
      .catch((e: unknown) => e)) as ToolError;

    expect(error.code).toBe("INVALID_ARGS");
    expect(error.hint).toBe("around returns at most 100 messages");
    expect(calls).toHaveLength(0);
  });
});

describe("discord_search_messages default scope", () => {
  it("scans only the 50 most recently active channels and says how many were skipped", async () => {
    // BigInt: these ids are above 2^53, where plain number arithmetic would collapse them.
    const channels = Array.from({ length: 60 }, (_, i) => ({
      id: (300000000000000000n + BigInt(i)).toString(),
      name: `c${i}`,
      type: 0,
      position: i,
      last_message_id: (400000000000000000n + BigInt(i)).toString(),
    }));
    const { rest, calls } = fakeRest({ "/messages": [] });

    const outcome = await registryWith([searchMessages], {
      rest,
      resolver: { ...resolver, channels: async () => channels, threads: async () => [] },
    }).run("discord_search_messages", { query: "needle" });

    const scanned = calls.filter((c) => c.route.includes("/messages")).map((c) => c.route);
    expect(scanned).toHaveLength(50);
    expect(scanned).toContain(`/channels/${channels[59]?.id}/messages`);
    expect(scanned).not.toContain(`/channels/${channels[0]?.id}/messages`);
    expect(outcome.summary).toContain("10 less active channels not searched");
    expect(outcome.summary).toContain("pass channels");
  });
});
