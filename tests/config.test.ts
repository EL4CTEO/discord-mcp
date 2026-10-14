import { delimiter } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

const base = { DISCORD_TOKEN: "token-abc" };

describe("loadConfig", () => {
  it("requires a token", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
  });

  it("treats an empty token as missing", () => {
    expect(() => loadConfig({ DISCORD_TOKEN: "" })).toThrow(/DISCORD_TOKEN/);
  });

  it("rejects a token pasted with the Bot prefix", () => {
    expect(() => loadConfig({ DISCORD_TOKEN: "Bot abc" })).toThrow(ConfigError);
  });

  it("falls back to defaults when optional variables are blank", () => {
    const config = loadConfig({
      ...base,
      DISCORD_DEFAULT_GUILD: "",
      DISCORD_ALLOW_DESTRUCTIVE: "",
      DISCORD_ALLOW_MASS_MENTIONS: "",
      DISCORD_PRIVILEGED_INTENTS: "",
      DISCORD_REQUEST_TIMEOUT_MS: "",
      DISCORD_MAX_RESPONSE_CHARS: "  ",
      DISCORD_GATEWAY_IDLE_MS: "",
      DISCORD_EVENT_BUFFER: "",
      DISCORD_BATCH_CONCURRENCY: "",
      DISCORD_UPLOAD_DIRS: "",
    });

    expect(config).toMatchObject({
      defaultGuild: undefined,
      allowDestructive: false,
      allowMassMentions: false,
      privilegedIntents: true,
      requestTimeoutMs: 15_000,
      maxResponseChars: 25_000,
      gatewayIdleMs: 120_000,
      eventBufferSize: 200,
      batchConcurrency: 4,
    });
    expect(config.uploadDirs).toEqual([process.cwd()]);
  });

  it.each(["yes", "1", "true"])("reads %s as on", (value) => {
    expect(loadConfig({ ...base, DISCORD_ALLOW_DESTRUCTIVE: value }).allowDestructive).toBe(true);
  });

  it.each(["no", "0", "false"])("reads %s as off", (value) => {
    expect(loadConfig({ ...base, DISCORD_PRIVILEGED_INTENTS: value }).privilegedIntents).toBe(false);
  });

  it("reads DISCORD_ALLOW_MASS_MENTIONS as an opt-in boolean", () => {
    expect(loadConfig(base).allowMassMentions).toBe(false);
    expect(loadConfig({ ...base, DISCORD_ALLOW_MASS_MENTIONS: "yes" }).allowMassMentions).toBe(true);
  });

  it("treats DISCORD_UPLOAD_DIRS='*' as unrestricted", () => {
    expect(loadConfig({ ...base, DISCORD_UPLOAD_DIRS: "*" }).uploadDirs).toBeUndefined();
  });

  it("splits DISCORD_UPLOAD_DIRS on the platform delimiter", () => {
    const dirs = ["C:/one", "C:/two"];
    expect(loadConfig({ ...base, DISCORD_UPLOAD_DIRS: dirs.join(delimiter) }).uploadDirs).toEqual(dirs);
  });

  it("rejects a malformed number rather than defaulting it", () => {
    expect(() => loadConfig({ ...base, DISCORD_REQUEST_TIMEOUT_MS: "soon" })).toThrow(ConfigError);
  });
});
