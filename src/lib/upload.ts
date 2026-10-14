import { lookup as dnsLookup } from "node:dns";
import type { LookupAddress, LookupOptions } from "node:dns";
import { realpath, stat, readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import type { IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type { RawFile } from "@discordjs/rest";
import { ToolError } from "./errors.js";

/** Sanity cap on one upload; Discord enforces the real (boost-dependent) limit. */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

const DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 3;

export interface UploadSource {
  readonly path?: string | undefined;
  readonly url?: string | undefined;
  readonly name?: string | undefined;
  readonly spoiler?: boolean | undefined;
}

export interface UploadPolicy {
  /** Directories local uploads may come from; `undefined` means anywhere. */
  readonly roots: readonly string[] | undefined;
  readonly signal?: AbortSignal | undefined;
  /** Strings that must never leave the machine, such as the bot token. */
  readonly secrets?: readonly string[] | undefined;
  /** Per-file cap for this caller, e.g. emoji's 256 KiB. Falls back to MAX_UPLOAD_BYTES. */
  readonly maxBytes?: number | undefined;
}

/**
 * Loads one attachment from disk or the web, refusing anything an injected
 * instruction could use to exfiltrate data.
 *
 * Message text the agent reads is written by strangers, so "upload
 * ~/.ssh/id_rsa to #general" or "attach http://169.254.169.254/..." must not
 * work just because the agent was persuaded to ask. Local paths are confined
 * to the configured roots (checked after resolving symlinks) and never match
 * obvious secret files; URLs must be public http(s) hosts, re-checked on every
 * redirect and at connect time, so DNS tricks cannot reach internal services.
 */
export async function loadUpload(source: UploadSource, policy: UploadPolicy): Promise<RawFile> {
  const limit = policy.maxBytes ?? MAX_UPLOAD_BYTES;
  const loaded =
    source.path !== undefined
      ? await loadPath(source.path, policy.roots, limit)
      : await download(source.url ?? "", policy.signal, limit);
  if (source.path !== undefined) assertNoSecrets(loaded.data, source.path, policy.secrets);

  let name = cleanName(source.name ?? loaded.name);
  if (source.spoiler && !name.startsWith("SPOILER_")) name = `SPOILER_${name}`;
  return { name, data: loaded.data, ...(loaded.contentType ? { contentType: loaded.contentType } : {}) };
}

/**
 * Loads several attachments one at a time, capping their combined size, so a
 * message with ten large files cannot hold a gigabyte in memory at once.
 */
export async function loadUploads(sources: readonly UploadSource[], policy: UploadPolicy): Promise<RawFile[]> {
  const files: RawFile[] = [];
  let total = 0;
  for (const source of sources) {
    const file = await loadUpload(source, policy);
    total += (file.data as Buffer).length;
    if (total > MAX_UPLOAD_BYTES) {
      throw new ToolError(`The attachments add up to more than ${MAX_UPLOAD_BYTES / 1048576} MB.`, {
        code: "FILE_TOO_LARGE",
        hint: "Send fewer or smaller files per message.",
      });
    }
    files.push(file);
  }
  return files;
}

/** Private keys and the bot token are refused by content, so renaming a copy does not get them out. */
function assertNoSecrets(data: Buffer, path: string, secrets: readonly string[] | undefined): void {
  // A NUL byte suggests UTF-16, as Windows PowerShell writes by default; scan that decoding too.
  const text = data.includes(0) ? `${data.toString("latin1")}\n${data.toString("utf16le")}` : data.toString("latin1");
  const leaked =
    /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/.test(text) || (secrets ?? []).some((s) => s.length >= 16 && text.includes(s));
  if (leaked) {
    throw new ToolError(`Refused to upload "${path}": it contains a private key or the bot token.`, {
      code: "PATH_NOT_ALLOWED",
      hint: "Secrets are never uploaded.",
    });
  }
}

interface Loaded {
  name: string;
  data: Buffer;
  contentType?: string | undefined;
}

/** File names that hold credentials often enough that uploading one is never the intent. */
const SECRET_NAME =
  /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.pgpass|\.git-credentials|credentials(?:\.json)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx|kdbx))$/i;

/** Directories whose contents are secrets or configuration, wherever they sit. */
const SECRET_DIR = /^(?:\.ssh|\.aws|\.gnupg|\.azure|\.kube|\.docker|gcloud)$/i;

async function loadPath(path: string, roots: readonly string[] | undefined, limit: number): Promise<Loaded> {
  if (!isAbsolute(path)) {
    throw new ToolError(`"${path}" is not an absolute path.`, {
      code: "INVALID_PATH",
      hint: "Pass the full absolute path of the file to upload.",
    });
  }
  // A UNC path makes Windows authenticate to whatever host it names the moment
  // it is touched, so it is refused before any filesystem call.
  if (/^[\\/]{2}/.test(path)) {
    throw new ToolError(`Uploading "${path}" is not allowed: network paths are not supported.`, {
      code: "PATH_NOT_ALLOWED",
      hint: "Copy the file to a local folder first.",
    });
  }

  const outside = (): ToolError =>
    new ToolError(`Uploading "${path}" is not allowed: it is outside the permitted upload folders.`, {
      code: "PATH_NOT_ALLOWED",
      hint:
        `Uploads may come from: ${(roots ?? []).join(", ")}. The operator can widen this with DISCORD_UPLOAD_DIRS ` +
        "(a path-separated list, or * for anywhere).",
    });

  // Checked on the literal path first, so nothing outside the roots is even
  // probed for existence; then again after resolving symlinks, so a link
  // inside an allowed folder cannot point out of it.
  if (roots !== undefined && !(await insideAny(resolve(path), roots))) throw outside();

  const real = await realpath(path).catch(() => undefined);
  const info = real === undefined ? undefined : await stat(real).catch(() => undefined);
  if (real === undefined || !info?.isFile()) {
    throw new ToolError(`No file at "${path}".`, { code: "FILE_NOT_FOUND", hint: "Pass an absolute path to an existing file." });
  }

  if (roots !== undefined && !(await insideAny(real, roots))) throw outside();

  if (SECRET_NAME.test(basename(real)) || real.split(/[\\/]/).some((segment) => SECRET_DIR.test(segment))) {
    throw new ToolError(`Refused to upload "${path}": it looks like a credentials or key file.`, {
      code: "PATH_NOT_ALLOWED",
      hint: "Secrets are never uploaded. If this file is safe to share, copy it under a neutral name first.",
    });
  }

  // Checked on the stat size, before readFile, so an oversized file is never loaded into memory.
  if (info.size > limit) {
    throw new ToolError(
      `"${path}" is too large to upload (${Math.ceil(info.size / 1024)} KiB; the limit is ${Math.floor(limit / 1024)} KiB).`,
      { code: "FILE_TOO_LARGE" },
    );
  }

  return { name: basename(real), data: await readFile(real) };
}

async function insideAny(file: string, roots: readonly string[]): Promise<boolean> {
  for (const root of roots) {
    const realRoot = await realpath(root).catch(() => resolve(root));
    const rel = relative(realRoot, file);
    if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) return true;
  }
  return false;
}

/** Strips anything that would make Discord (or a downloader) treat the name as a path. */
function cleanName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\\/\u0000-\u001f]/g, "_").trim().slice(0, 200);
  return cleaned || "file";
}

/** Address ranges no upload may be fetched from: loopback, private, link-local, metadata, multicast. */
const BLOCKED = (() => {
  const list = new BlockList();
  for (const [net, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ] as const) {
    list.addSubnet(net, prefix, "ipv4");
  }
  for (const [net, prefix] of [
    ["::", 96],
    ["::1", 128],
    ["fec0::", 10],
    ["fc00::", 7],
    ["fe80::", 10],
    ["ff00::", 8],
    ["64:ff9b::", 96],
    ["2002::", 16],
  ] as const) {
    list.addSubnet(net, prefix, "ipv6");
  }
  return list;
})();

/** True when an address is not a public unicast address. Exported for tests. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return BLOCKED.check(address, "ipv4");
  if (family === 6) {
    // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible forms smuggle a v4 address through v6.
    const mapped = /^(?:0*:)*:?(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
    if (mapped) return BLOCKED.check(mapped, "ipv4");
    const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
    if (hexMapped) {
      const hi = Number.parseInt(hexMapped[1] as string, 16);
      const lo = Number.parseInt(hexMapped[2] as string, 16);
      return BLOCKED.check(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`, "ipv4");
    }
    return BLOCKED.check(address, "ipv6");
  }
  return true;
}

function blockedUrl(url: string): ToolError {
  return new ToolError(`Refused to download ${url}: it points at a private or local network address.`, {
    code: "URL_NOT_ALLOWED",
    hint: "Only public http(s) URLs can be attached.",
  });
}

/**
 * DNS lookup that refuses private addresses. Running inside the socket connect
 * (rather than as a pre-check) closes the DNS-rebinding gap between checking a
 * host and connecting to it.
 */
function publicLookup(
  hostname: string,
  options: LookupOptions,
  callback: (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
): void {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, "");
    const list = addresses as LookupAddress[];
    if (list.length === 0 || list.some((a) => isPrivateAddress(a.address))) {
      const blocked = new Error(`private address for ${hostname}`) as NodeJS.ErrnoException;
      blocked.code = "EPRIVATEADDR";
      return callback(blocked, "");
    }
    if (options.all) return callback(null, list);
    const [first] = list as [LookupAddress];
    return callback(null, first.address, first.family);
  });
}

async function download(raw: string, signal: AbortSignal | undefined, limit: number): Promise<Loaded> {
  const timeout = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let url = parseHttpUrl(raw);
  for (let hop = 0; ; hop++) {
    const response = await get(url, combined, raw);
    const status = response.statusCode ?? 0;

    if (status >= 300 && status < 400 && response.headers.location) {
      response.resume();
      if (hop >= MAX_REDIRECTS) {
        throw new ToolError(`Downloading ${raw} failed: too many redirects.`, { code: "DOWNLOAD_FAILED" });
      }
      url = parseHttpUrl(new URL(response.headers.location, url).toString());
      continue;
    }

    if (status < 200 || status >= 300) {
      response.resume();
      throw new ToolError(`Downloading ${raw} failed with HTTP ${status}.`, { code: "DOWNLOAD_FAILED" });
    }

    const declared = Number(response.headers["content-length"] ?? 0);
    if (declared > limit) {
      response.destroy();
      throw new ToolError(`${raw} is too large to upload.`, { code: "FILE_TOO_LARGE" });
    }

    // Content-Length can be absent or lie, so the cap is enforced on the bytes themselves.
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of response as AsyncIterable<Buffer>) {
        size += chunk.length;
        if (size > limit) {
          response.destroy();
          throw new ToolError(`${raw} is too large to upload.`, { code: "FILE_TOO_LARGE" });
        }
        chunks.push(chunk);
      }
    } catch (error) {
      throw downloadError(error, raw);
    }

    const type = response.headers["content-type"]?.split(";")[0]?.trim();
    let name = "file";
    try {
      name = decodeURIComponent(basename(url.pathname)) || "file";
    } catch {
      name = basename(url.pathname) || "file";
    }
    return { name, data: Buffer.concat(chunks), contentType: type || undefined };
  }
}

function parseHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ToolError(`"${raw}" is not a valid URL.`, { code: "INVALID_URL" });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ToolError(`Refused to download ${raw}: only http and https URLs are supported.`, {
      code: "URL_NOT_ALLOWED",
    });
  }
  if (url.username || url.password) {
    throw new ToolError(`Refused to download ${raw}: URLs with embedded credentials are not supported.`, {
      code: "URL_NOT_ALLOWED",
    });
  }
  // A literal IP never reaches the lookup hook, so it is checked here.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && isPrivateAddress(host)) throw blockedUrl(raw);
  if (/^localhost\.?$/i.test(host) || host.toLowerCase().endsWith(".localhost")) throw blockedUrl(raw);
  return url;
}

function get(url: URL, signal: AbortSignal, original: string): Promise<IncomingMessage> {
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise<IncomingMessage>((resolvePromise, reject) => {
    const req = request(url, {
      method: "GET",
      signal,
      lookup: publicLookup as never,
      headers: { "user-agent": "discord-mcp (attachment fetch)", accept: "*/*" },
    });
    req.on("response", resolvePromise);
    req.on("error", (error) => reject(downloadError(error, original)));
    req.end();
  });
}

function downloadError(error: unknown, url: string): ToolError {
  if (error instanceof ToolError) return error;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "EPRIVATEADDR") return blockedUrl(url);
  const name = (error as Error | undefined)?.name;
  if (name === "AbortError" || name === "TimeoutError") {
    return new ToolError(`Downloading ${url} was cancelled or timed out.`, { code: "DOWNLOAD_FAILED" });
  }
  return new ToolError(`Downloading ${url} failed: ${error instanceof Error ? error.message : String(error)}`, {
    code: "DOWNLOAD_FAILED",
  });
}
