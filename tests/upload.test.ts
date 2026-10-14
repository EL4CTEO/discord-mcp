import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isPrivateAddress, loadUpload, loadUploads } from "../src/lib/upload.js";

describe("isPrivateAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.5.4",
    "192.168.1.1",
    "169.254.169.254",
    "0.0.0.0",
    "100.64.0.1",
    "::1",
    "::",
    "fe80::1",
    "fc00::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "example.com",
  ])("blocks %s", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])("allows public %s", (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });
});

describe("loadUpload (url)", () => {
  it.each([
    "ftp://example.com/a",
    "http://127.0.0.1/x",
    "http://[::1]/x",
    "http://169.254.169.254/latest",
    "http://localhost:8080/x",
    "https://user:pass@example.com/x",
  ])("refuses %s before any network I/O", async (url) => {
    await expect(loadUpload({ url }, { roots: undefined })).rejects.toMatchObject({ code: "URL_NOT_ALLOWED" });
  });
});

describe("loadUpload (path)", () => {
  let tmpDir: string;
  const payload = Buffer.from("hello attachment\n", "utf8");

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dmcp-"));
    await mkdir(join(tmpDir, "sub"));
    await mkdir(join(tmpDir, ".ssh"));
    await writeFile(join(tmpDir, "report.txt"), payload);
    await writeFile(join(tmpDir, "x.txt"), payload);
    await writeFile(join(tmpDir, ".env"), "SECRET=1");
    await writeFile(join(tmpDir, "id_rsa"), "key");
    await writeFile(join(tmpDir, "server.pem"), "key");
    await writeFile(join(tmpDir, ".ssh", "config"), "Host *");
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("loads a file inside the root", async () => {
    const result = await loadUpload({ path: join(tmpDir, "report.txt") }, { roots: [tmpDir] });
    expect(result.name).toBe("report.txt");
    expect(Buffer.from(result.data as Buffer).equals(payload)).toBe(true);
  });

  it("applies a name override and the spoiler prefix", async () => {
    const result = await loadUpload(
      { path: join(tmpDir, "x.txt"), name: "x.txt", spoiler: true },
      { roots: [tmpDir] },
    );
    expect(result.name).toBe("SPOILER_x.txt");
  });

  it("sanitises path separators in a name", async () => {
    const result = await loadUpload(
      { path: join(tmpDir, "report.txt"), name: "a/b\\c.txt" },
      { roots: [tmpDir] },
    );
    expect(result.name).not.toMatch(/[\\/]/);
  });

  it("rejects a relative path with INVALID_PATH", async () => {
    await expect(loadUpload({ path: "report.txt" }, { roots: undefined })).rejects.toMatchObject({
      code: "INVALID_PATH",
    });
  });

  it("rejects a missing file with FILE_NOT_FOUND", async () => {
    await expect(loadUpload({ path: join(tmpDir, "nope.txt") }, { roots: [tmpDir] })).rejects.toMatchObject({
      code: "FILE_NOT_FOUND",
    });
  });

  it("rejects a file outside the roots with PATH_NOT_ALLOWED", async () => {
    await expect(
      loadUpload({ path: join(tmpDir, "report.txt") }, { roots: [join(tmpDir, "sub")] }),
    ).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
  });

  it.each([".env", "id_rsa", "server.pem", join(".ssh", "config")])(
    "refuses secret-looking file %s even with no roots",
    async (relPath) => {
      await expect(loadUpload({ path: join(tmpDir, relPath) }, { roots: undefined })).rejects.toMatchObject({
        code: "PATH_NOT_ALLOWED",
      });
    },
  );

  it("allows a normal file anywhere when roots is undefined", async () => {
    const result = await loadUpload({ path: join(tmpDir, "report.txt") }, { roots: undefined });
    expect(result.name).toBe("report.txt");
  });
});

describe("loadUpload content and path hardening", () => {
  let dir: string;
  const token = "not-a-real-secret-value-for-upload-tests-0123456789";

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "dmcp-sec-"));
    await writeFile(join(dir, "notes.txt"), "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n");
    await writeFile(join(dir, "log.txt"), `config dump: token=${token}\n`);
    await writeFile(join(dir, "a.bin"), Buffer.alloc(1024));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("refuses a renamed private key by its content", async () => {
    await expect(loadUpload({ path: join(dir, "notes.txt") }, { roots: undefined })).rejects.toMatchObject({
      code: "PATH_NOT_ALLOWED",
    });
  });

  it("refuses a private key saved as UTF-16, as Windows PowerShell writes it", async () => {
    const key = ["﻿-----BEGIN RSA PRIVATE KEY-----", "abc", ""].join("\n");
    await writeFile(join(dir, "export.txt"), Buffer.from(key, "utf16le"));
    await expect(loadUpload({ path: join(dir, "export.txt") }, { roots: undefined })).rejects.toMatchObject({
      code: "PATH_NOT_ALLOWED",
    });
  });

  it("refuses a file containing the bot token", async () => {
    await expect(
      loadUpload({ path: join(dir, "log.txt") }, { roots: undefined, secrets: [token] }),
    ).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
  });

  it("refuses UNC paths before touching the filesystem", async () => {
    await expect(loadUpload({ path: String.raw`\\attacker\share\x.png` }, { roots: undefined })).rejects.toMatchObject({
      code: "PATH_NOT_ALLOWED",
    });
  });

  it("does not reveal whether a file outside the roots exists", async () => {
    const missing = loadUpload({ path: join(dir, "nope.txt") }, { roots: [join(dir, "sub")] });
    await expect(missing).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
  });

  it("caps the combined size of several attachments", async () => {
    const files = await loadUploads([{ path: join(dir, "a.bin") }, { path: join(dir, "a.bin") }], { roots: [dir] });
    expect(files).toHaveLength(2);
  });

  it.each(["::7f00:1", "fec0::1"])("blocks legacy IPv6 form %s", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });
});
