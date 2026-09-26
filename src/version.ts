import { readFileSync } from "node:fs";

/**
 * The package version, read once from package.json so the MCP handshake and
 * the REST user agent never drift from what was actually released.
 *
 * Resolved relative to this module, which sits one level below the package
 * root both as src/version.ts (dev) and dist/version.js (built).
 */
export const VERSION: string = (() => {
  try {
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof version === "string" ? version : "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
