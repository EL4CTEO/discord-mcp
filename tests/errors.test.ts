import { describe, expect, it } from "vitest";
import { DiscordAPIError } from "@discordjs/rest";
import { destructiveDisabled, normalizeError, ToolError } from "../src/lib/errors.js";

const apiError = (code: number, status: number) =>
  new DiscordAPIError({ code, message: "Missing Permissions" }, code, status, "POST", "https://x", {});

describe("normalizeError", () => {
  it("turns a permissions error into role-hierarchy guidance", () => {
    const error = normalizeError(apiError(50013, 403), "ban member");

    expect(error).toBeInstanceOf(ToolError);
    expect(error.message).toContain("ban member");
    expect(error.hint).toContain("ABOVE the target user");
  });

  it("explains an unknown channel by pointing at the listing tool", () => {
    expect(normalizeError(apiError(10003, 404), "send message").hint).toContain("discord_list_channels");
  });

  it("falls back to status advice for unmapped codes", () => {
    expect(normalizeError(apiError(99999, 401), "do a thing").hint).toContain("Reset Token");
  });

  it("maps a timeout to a retry hint", () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(normalizeError(abort, "read messages").hint).toContain("DISCORD_REQUEST_TIMEOUT_MS");
  });

  it("passes an existing ToolError through unchanged", () => {
    const original = new ToolError("already shaped", { code: "X" });
    expect(normalizeError(original, "anything")).toBe(original);
  });

  it("handles non-Error throws", () => {
    expect(normalizeError("plain string", "do a thing").message).toContain("plain string");
  });
});

describe("ToolError.toText", () => {
  it("includes the hint on its own line when present", () => {
    expect(new ToolError("Nope.", { hint: "Try X." }).toText()).toBe("Nope.\nHint: Try X.");
  });

  it("omits the hint line when there is none", () => {
    expect(new ToolError("Nope.").toText()).toBe("Nope.");
  });
});

describe("destructiveDisabled", () => {
  it("names the env var the operator has to set", () => {
    const error = destructiveDisabled("discord_moderate_member");
    expect(error.hint).toContain("DISCORD_ALLOW_DESTRUCTIVE=true");
    expect(error.code).toBe("DESTRUCTIVE_DISABLED");
  });
});
