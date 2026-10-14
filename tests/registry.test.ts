import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { defineTool, renderOutcome, strictInputSchema, ToolRegistry } from "../src/tools/registry.js";
import { batch } from "../src/tools/batch.js";
import { ToolError } from "../src/lib/errors.js";
import { config } from "./helpers.js";


const makeRegistry = (cfg = config()) =>
  new ToolRegistry({
    config: cfg,
    rest: {} as never,
    resolver: {} as never,
    gateway: {} as never,
  });

const echo = defineTool({
  name: "echo",
  title: "Echo",
  description: "Returns what it was given.",
  inputSchema: { text: z.string().min(1) },
  async handler(args) {
    return { summary: `echo: ${args.text}`, data: { text: args.text } };
  },
});

const nuke = defineTool({
  name: "nuke",
  title: "Nuke",
  description: "Destroys things.",
  destructive: true,
  inputSchema: {},
  async handler() {
    return { summary: "boom" };
  },
});

describe("ToolRegistry", () => {
  it("runs a registered tool", async () => {
    const registry = makeRegistry().add(echo);
    await expect(registry.run("echo", { text: "hi" })).resolves.toMatchObject({ summary: "echo: hi" });
  });

  it("rejects duplicate tool names at registration time", () => {
    expect(() => makeRegistry().add(echo, echo)).toThrow(/Duplicate tool name/);
  });

  it("lists available tools when an unknown one is called", async () => {
    const error = (await makeRegistry().add(echo).run("nope", {}).catch((e: unknown) => e)) as ToolError;
    expect(error.code).toBe("UNKNOWN_TOOL");
    expect(error.hint).toContain("echo");
  });

  it("blocks destructive tools unless explicitly enabled", async () => {
    const error = (await makeRegistry().add(nuke).run("nuke", {}).catch((e: unknown) => e)) as ToolError;
    expect(error.code).toBe("DESTRUCTIVE_DISABLED");
  });

  it("allows destructive tools once enabled", async () => {
    const registry = makeRegistry(config({ allowDestructive: true })).add(nuke);
    await expect(registry.run("nuke", {})).resolves.toMatchObject({ summary: "boom" });
  });

  it("reports invalid arguments with the expected field names", async () => {
    const error = (await makeRegistry().add(echo).run("echo", {}).catch((e: unknown) => e)) as ToolError;
    expect(error.code).toBe("INVALID_ARGS");
    expect(error.hint).toContain("text");
  });

  it("rejects unknown argument keys rather than ignoring them", async () => {
    const error = (await makeRegistry()
      .add(echo)
      .run("echo", { text: "hi", typo: 1 })
      .catch((e: unknown) => e)) as ToolError;
    expect(error.code).toBe("INVALID_ARGS");
  });

  it("normalises errors thrown inside a handler", async () => {
    const boom = defineTool({
      name: "boom",
      title: "Boom",
      description: "Throws.",
      inputSchema: {},
      async handler() {
        throw new Error("underlying failure");
      },
    });

    const error = (await makeRegistry().add(boom).run("boom", {}).catch((e: unknown) => e)) as ToolError;
    expect(error.message).toContain("underlying failure");
    expect(error.message).toContain("boom");
  });
});

describe("renderOutcome", () => {
  it("returns the summary alone when there is no data", () => {
    const result = renderOutcome({ summary: "done" }, 25000);
    expect(result.content[0]).toEqual({ type: "text", text: "done" });
    expect(result.structuredContent).toBeUndefined();
  });

  it("attaches structured content for objects", () => {
    const result = renderOutcome({ summary: "s", data: { a: 1 } }, 25000);
    expect(result.structuredContent).toEqual({ a: 1 });
  });

  it("wraps array data so structured content is always an object", () => {
    const result = renderOutcome({ summary: "s", data: [1, 2] }, 25000);
    expect(result.structuredContent).toEqual({ result: [1, 2] });
  });

  it("truncates long arrays and says how many were dropped", () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({ id: i, text: "x".repeat(50) }));
    const text = renderOutcome({ summary: "s", data: rows }, 3000).content[0] as { text: string };

    expect(text.text.length).toBeLessThan(3600);
    expect(text.text).toMatch(/\d+ list item\(s\) omitted/);
  });

  it("leaves small payloads untouched", () => {
    const text = renderOutcome({ summary: "s", data: [1, 2, 3] }, 25000).content[0] as { text: string };
    expect(text.text).not.toContain("truncated");
  });
});

describe("discord_batch", () => {
  const registryWithBatch = (cfg = config()) => {
    const registry = makeRegistry(cfg).add(echo, nuke, batch);
    return registry;
  };

  it("runs every operation and reports each result", async () => {
    const outcome = await registryWithBatch().run("discord_batch", {
      operations: [
        { tool: "echo", args: { text: "a" } },
        { tool: "echo", args: { text: "b" } },
      ],
    });

    expect(outcome.summary).toContain("2/2 succeeded");
    expect(outcome.data).toMatchObject([
      { index: 0, ok: true, summary: "echo: a" },
      { index: 1, ok: true, summary: "echo: b" },
    ]);
  });

  it("keeps successes when one operation fails", async () => {
    const outcome = await registryWithBatch().run("discord_batch", {
      operations: [
        { tool: "echo", args: { text: "a" } },
        { tool: "echo", args: {} },
        { tool: "echo", args: { text: "c" } },
      ],
    });

    expect(outcome.summary).toContain("2/3 succeeded");
    const rows = outcome.data as Array<{ ok: boolean; error?: string }>;
    expect(rows[1]?.ok).toBe(false);
    expect(rows[1]?.error).toContain("Invalid arguments");
    expect(rows[2]?.ok).toBe(true);
  });

  it("applies the destructive gate to nested operations too", async () => {
    const outcome = await registryWithBatch().run("discord_batch", {
      operations: [{ tool: "nuke", args: {} }],
    });

    const rows = outcome.data as Array<{ ok: boolean; error?: string }>;
    expect(rows[0]?.ok).toBe(false);
    expect(rows[0]?.error).toContain("DISCORD_ALLOW_DESTRUCTIVE");
  });

  it("refuses to nest batches", async () => {
    const error = (await registryWithBatch()
      .run("discord_batch", { operations: [{ tool: "discord_batch", args: {} }] })
      .catch((e: unknown) => e)) as ToolError;

    expect(error.code).toBe("NESTED_BATCH");
  });

  it("respects the concurrency ceiling", async () => {
    let active = 0;
    let peak = 0;

    const slow = defineTool({
      name: "slow",
      title: "Slow",
      description: "Waits.",
      inputSchema: {},
      async handler() {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        active -= 1;
        return { summary: "ok" };
      },
    });

    const registry = makeRegistry().add(slow, batch);
    await registry.run("discord_batch", {
      operations: Array.from({ length: 12 }, () => ({ tool: "slow", args: {} })),
      concurrency: 2,
    });

    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe("batch lane scheduling", () => {
  /** Records how many operations were in flight per bucket at any moment. */
  const tracker = () => {
    const active = new Map<string, number>();
    const peak = new Map<string, number>();
    return {
      peak,
      enter(key: string) {
        const n = (active.get(key) ?? 0) + 1;
        active.set(key, n);
        peak.set(key, Math.max(peak.get(key) ?? 0, n));
      },
      leave(key: string) {
        active.set(key, (active.get(key) ?? 1) - 1);
      },
    };
  };

  const probe = (t: ReturnType<typeof tracker>) =>
    defineTool({
      name: "probe",
      title: "Probe",
      description: "Records concurrency per channel.",
      inputSchema: { channel: z.string() },
      async handler(args) {
        t.enter(args.channel);
        await new Promise((r) => setTimeout(r, 15));
        t.leave(args.channel);
        return { summary: `hit ${args.channel}` };
      },
    });

  it("never overlaps operations sharing one rate-limit bucket", async () => {
    const t = tracker();
    const registry = makeRegistry().add(probe(t), batch);

    await registry.run("discord_batch", {
      operations: Array.from({ length: 6 }, () => ({ tool: "probe", args: { channel: "general" } })),
      concurrency: 6,
    });

    expect(t.peak.get("general")).toBe(1);
  });

  it("still runs different buckets in parallel", async () => {
    const t = tracker();
    const registry = makeRegistry().add(probe(t), batch);

    const started = Date.now();
    await registry.run("discord_batch", {
      operations: ["a", "b", "c", "d"].map((channel) => ({ tool: "probe", args: { channel } })),
      concurrency: 4,
    });

    // Four 15ms operations, one per bucket: parallel finishes well under serial.
    expect(Date.now() - started).toBeLessThan(45);
    for (const channel of ["a", "b", "c", "d"]) expect(t.peak.get(channel)).toBe(1);
  });

  it("returns results in the caller's order despite lane reordering", async () => {
    const t = tracker();
    const registry = makeRegistry().add(probe(t), batch);

    const outcome = await registry.run("discord_batch", {
      operations: [
        { tool: "probe", args: { channel: "x" } },
        { tool: "probe", args: { channel: "y" } },
        { tool: "probe", args: { channel: "x" } },
        { tool: "probe", args: { channel: "y" } },
      ],
      concurrency: 4,
    });

    const rows = outcome.data as Array<{ index: number; summary: string }>;
    expect(rows.map((r) => r.index)).toEqual([0, 1, 2, 3]);
    expect(rows.map((r) => r.summary)).toEqual(["hit x", "hit y", "hit x", "hit y"]);
  });
});

describe("bulk arguments", () => {
  const seen: string[] = [];

  const greet = defineTool({
    name: "greet",
    title: "Greet",
    description: "Greets one target.",
    bulkArgs: ["who"],
    inputSchema: { who: z.string(), loudly: z.boolean().default(false) },
    async handler(args) {
      seen.push(args.who);
      if (args.who === "boom") throw new Error("nope");
      return { summary: `hi ${args.who}${args.loudly ? "!" : ""}`, data: { who: args.who } };
    },
  });

  const registry = () => {
    seen.length = 0;
    return makeRegistry().add(greet);
  };

  it("still accepts a single value and returns the plain outcome", async () => {
    const outcome = await registry().run("greet", { who: "ada" });
    expect(outcome.summary).toBe("hi ada");
    expect(outcome.data).toEqual({ who: "ada" });
  });

  it("fans an array out to one handler call per item", async () => {
    const outcome = await registry().run("greet", { who: ["ada", "grace", "alan"] });

    expect(seen.sort()).toEqual(["ada", "alan", "grace"]);
    expect(outcome.summary).toContain("3 items: 3 succeeded");
  });

  it("carries the other arguments into every item", async () => {
    const outcome = await registry().run("greet", { who: ["ada", "grace"], loudly: true });
    const rows = outcome.data as Array<{ summary: string }>;
    expect(rows.map((r) => r.summary)).toEqual(["hi ada!", "hi grace!"]);
  });

  it("reports per-item results in the caller's order, failures included", async () => {
    const outcome = await registry().run("greet", { who: ["ada", "boom", "grace"] });
    const rows = outcome.data as Array<{ who: string; ok: boolean; error?: string }>;

    expect(rows.map((r) => r.who)).toEqual(["ada", "boom", "grace"]);
    expect(rows.map((r) => r.ok)).toEqual([true, false, true]);
    expect(rows[1]?.error).toContain("nope");
    expect(outcome.summary).toContain("2 succeeded, 1 failed");
  });

  it("rejects an empty array rather than silently doing nothing", async () => {
    const error = (await registry().run("greet", { who: [] }).catch((e: unknown) => e)) as ToolError;
    expect(error.code).toBe("INVALID_ARGS");
  });

  it("leaves tools without a bulkArg strictly single-valued", async () => {
    const error = (await makeRegistry().add(echo).run("echo", { text: ["a", "b"] }).catch((e: unknown) => e)) as ToolError;
    expect(error.code).toBe("INVALID_ARGS");
  });
});

const greet = defineTool({
  name: "greet",
  title: "Greet",
  description: "Greets one target; 'boom' always fails.",
  bulkArgs: ["who"],
  inputSchema: { who: z.string() },
  async handler(args) {
    if (args.who === "boom") throw new Error("nope");
    return { summary: `hi ${args.who}`, data: { who: args.who } };
  },
});

describe("bulk failure reporting", () => {
  it("marks a fan-out where every item failed", async () => {
    const outcome = await makeRegistry().add(greet).run("greet", { who: ["boom", "boom"] });
    expect(outcome.failed).toBe("all");
    expect(outcome.summary).toContain("0 succeeded, 2 failed");
  });

  it("marks a partly failed fan-out as partial", async () => {
    const outcome = await makeRegistry().add(greet).run("greet", { who: ["ada", "boom"] });
    expect(outcome.failed).toBe("some");
  });

  it("leaves a clean fan-out unmarked", async () => {
    const outcome = await makeRegistry().add(greet).run("greet", { who: ["ada", "grace"] });
    expect(outcome.failed).toBeUndefined();
  });

  it("renders an all-failed fan-out as an error result, keeping the per-item detail", async () => {
    const outcome = await makeRegistry().add(greet).run("greet", { who: ["boom"] });
    const result = renderOutcome(outcome, 25000);
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("nope");
  });

  it("does not render a partly failed fan-out as an error", async () => {
    const outcome = await makeRegistry().add(greet).run("greet", { who: ["ada", "boom"] });
    expect(renderOutcome(outcome, 25000).isError).toBeUndefined();
  });

  it("reports a batch operation whose fan-out all failed as failed, with the item errors", async () => {
    const outcome = await makeRegistry()
      .add(greet, batch)
      .run("discord_batch", {
        operations: [
          { tool: "greet", args: { who: ["boom", "boom"] } },
          { tool: "greet", args: { who: "ada" } },
        ],
      });

    const rows = outcome.data as Array<{ ok: boolean; error?: string }>;
    expect(rows[0]?.ok).toBe(false);
    expect(rows[0]?.error).toContain("0 succeeded, 2 failed");
    expect(rows[0]?.error).toContain("boom: Could not greet: nope");
    expect(rows[1]?.ok).toBe(true);
  });

  it("keeps running past a partly failed fan-out without stop_on_error", async () => {
    const outcome = await makeRegistry()
      .add(greet, echo, batch)
      .run("discord_batch", {
        operations: [
          { tool: "greet", args: { who: ["ada", "boom"] } },
          { tool: "echo", args: { text: "after" } },
        ],
        concurrency: 1,
      });

    const rows = outcome.data as Array<{ ok: boolean }>;
    expect(rows.map((r) => r.ok)).toEqual([true, true]);
  });

  it("stop_on_error halts the batch when a fan-out partly fails", async () => {
    const outcome = await makeRegistry()
      .add(greet, echo, batch)
      .run("discord_batch", {
        operations: [
          { tool: "greet", args: { who: ["ada", "boom"] } },
          { tool: "echo", args: { text: "after" } },
        ],
        concurrency: 1,
        stop_on_error: true,
      });

    const rows = outcome.data as Array<{ ok: boolean; error?: string }>;
    expect(rows[0]?.ok).toBe(false);
    expect(rows[0]?.error).toContain("boom: Could not greet: nope");
    expect(rows[1]?.ok).toBe(false);
    expect(rows[1]?.error).toContain("Skipped");
  });
});

describe("batch call budget", () => {
  let ran = 0;
  const counted = defineTool({
    name: "counted",
    title: "Counted",
    description: "Counts calls.",
    bulkArgs: ["who"],
    inputSchema: { who: z.string() },
    async handler() {
      ran += 1;
      return { summary: "ok" };
    },
  });

  const targets = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`);

  it("rejects a batch whose fan-outs add up past the limit, before running anything", async () => {
    ran = 0;
    const error = (await makeRegistry()
      .add(counted, batch)
      .run("discord_batch", {
        operations: [
          { tool: "counted", args: { who: targets(50) } },
          { tool: "counted", args: { who: targets(50) } },
          { tool: "counted", args: { who: targets(1) } },
        ],
      })
      .catch((e: unknown) => e)) as ToolError;

    expect(error.code).toBe("TOO_MANY_CALLS");
    expect(error.message).toContain("101");
    expect(ran).toBe(0);
  });

  it("allows a batch at exactly the limit", async () => {
    ran = 0;
    await makeRegistry()
      .add(counted, batch)
      .run("discord_batch", {
        operations: [
          { tool: "counted", args: { who: targets(50) } },
          { tool: "counted", args: { who: targets(50) } },
        ],
      });
    expect(ran).toBe(100);
  });

  it("does not multiply concurrency when a fan-out runs inside a batch", async () => {
    let active = 0;
    let peak = 0;
    const tracked = defineTool({
      name: "tracked",
      title: "Tracked",
      description: "Counts in-flight calls.",
      bulkArgs: ["who"],
      inputSchema: { channel: z.string(), who: z.string() },
      async handler() {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
        return { summary: "ok" };
      },
    });

    await makeRegistry()
      .add(tracked, batch)
      .run("discord_batch", {
        operations: [
          { tool: "tracked", args: { channel: "a", who: targets(5) } },
          { tool: "tracked", args: { channel: "b", who: targets(5) } },
        ],
        concurrency: 2,
      });

    // Two batch lanes, each fanning out one item at a time.
    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe("unknown tool hint", () => {
  it("hides destructive tools while they are disabled", async () => {
    const error = (await makeRegistry().add(echo, nuke).run("nope", {}).catch((e: unknown) => e)) as ToolError;
    expect(error.hint).toContain("echo");
    expect(error.hint).not.toContain("nuke");
  });

  it("lists destructive tools once they are enabled", async () => {
    const error = (await makeRegistry(config({ allowDestructive: true }))
      .add(echo, nuke)
      .run("nope", {})
      .catch((e: unknown) => e)) as ToolError;
    expect(error.hint).toContain("nuke");
  });
});

describe("render budget", () => {
  it("clips an oversized summary so the data still gets room", () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ id: i, text: "x".repeat(40) }));
    const text = (renderOutcome({ summary: "s".repeat(10_000), data: rows }, 2_000).content[0] as { text: string }).text;

    expect(text.length).toBeLessThan(2_400);
    expect(text).toContain('"id":0');
  });
});

describe("strict input schema", () => {
  const open: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(open.splice(0).map((peer) => peer.close()));
  });

  /** Serves `echo` over the real MCP SDK, registered the way server.ts registers tools. */
  async function connectEcho(): Promise<Client> {
    const registry = makeRegistry().add(echo);
    const server = new McpServer({ name: "test", version: "0.0.0" });
    server.registerTool(
      echo.name,
      { title: echo.title, description: echo.description, inputSchema: strictInputSchema(echo) },
      async (args) => renderOutcome(await registry.run(echo.name, args), 25_000),
    );

    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    open.push(client, server);
    return client;
  }

  it("rejects unknown keys over the wire instead of silently dropping them", async () => {
    const client = await connectEcho();
    const result = await client.callTool({ name: "echo", arguments: { text: "hi", typo: 1 } });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]?.text).toContain("typo");
  });

  it("still accepts a valid call", async () => {
    const client = await connectEcho();
    const result = await client.callTool({ name: "echo", arguments: { text: "hi" } });
    expect((result.content as Array<{ text: string }>)[0]?.text).toContain("echo: hi");
  });

  it("advertises the schema as closed to unknown keys", async () => {
    const client = await connectEcho();
    const { tools } = await client.listTools();
    expect(tools[0]?.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
  });
});
