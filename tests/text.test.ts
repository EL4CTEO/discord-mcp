import { describe, expect, it } from "vitest";
import { MESSAGE_LIMIT, parseEmoji, splitMessage } from "../src/lib/text.js";

describe("splitMessage", () => {
  it("leaves short text alone", () => {
    expect(splitMessage("hello")).toEqual(["hello"]);
  });

  it("keeps every chunk within Discord's limit", () => {
    const text = Array.from({ length: 400 }, (_, i) => `line ${i} ${"word ".repeat(5)}`).join("\n");
    const chunks = splitMessage(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(MESSAGE_LIMIT);
  });

  it("prefers paragraph and line boundaries over mid-line cuts", () => {
    const para = "a".repeat(1200);
    const chunks = splitMessage(`${para}\n\n${para}`);
    expect(chunks).toEqual([para, para]);
  });

  it("closes and reopens a code fence cut across chunks", () => {
    const code = Array.from({ length: 200 }, (_, i) => `const x${i} = ${i};`).join("\n");
    const chunks = splitMessage(`Intro\n\`\`\`ts\n${code}\n\`\`\`\nOutro`);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const fences = chunk.split("\n").filter((l) => l.trimStart().startsWith("```")).length;
      expect(fences % 2).toBe(0);
      expect(chunk.length).toBeLessThanOrEqual(MESSAGE_LIMIT);
    }
    expect(chunks[1]?.startsWith("```ts\n")).toBe(true);
  });

  it("hard-cuts a single enormous word without splitting a surrogate pair", () => {
    const text = `${"x".repeat(1995)}\u{1F600}${"y".repeat(3000)}`;
    const chunks = splitMessage(text);
    expect(chunks.join("")).toBe(text);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(MESSAGE_LIMIT);
  });
});

describe("parseEmoji", () => {
  it("passes unicode emoji through", () => {
    expect(parseEmoji("✅")).toEqual({ route: "✅" });
  });

  it("normalises pasted custom emoji markup", () => {
    expect(parseEmoji("<:party:123456789012345678>")).toEqual({ route: "party:123456789012345678" });
    expect(parseEmoji("<a:party:123456789012345678>")).toEqual({ route: "party:123456789012345678" });
    expect(parseEmoji("party:123456789012345678")).toEqual({ route: "party:123456789012345678" });
  });

  it("marks bare names for lookup in the server", () => {
    expect(parseEmoji(":partyparrot:")).toEqual({ lookup: "partyparrot" });
    expect(parseEmoji("partyparrot")).toEqual({ lookup: "partyparrot" });
  });
});
