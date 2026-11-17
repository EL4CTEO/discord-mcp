#!/usr/bin/env node
// Launches the native discord-mcp binary for this platform.
//
// npm installs exactly one @el4cteo/discord-mcp-<platform>-<arch> package (an
// optional dependency matched by its os/cpu fields); this script finds its
// binary and hands it stdin, stdout and stderr untouched, since stdout carries
// the MCP JSON-RPC stream.
"use strict";

const { spawn } = require("node:child_process");
const path = require("node:path");

const SUPPORTED = ["win32-x64", "linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"];

function binaryPath() {
  if (process.env.DISCORD_MCP_BINARY) return process.env.DISCORD_MCP_BINARY;
  const target = `${process.platform}-${process.arch}`;
  const exe = process.platform === "win32" ? "discord-mcp.exe" : "discord-mcp";
  try {
    const pkg = require.resolve(`@el4cteo/discord-mcp-${target}/package.json`);
    return path.join(path.dirname(pkg), "bin", exe);
  } catch {
    const supported = SUPPORTED.includes(target);
    process.stderr.write(
      supported
        ? `discord-mcp: the binary package @el4cteo/discord-mcp-${target} is missing. ` +
            "Reinstall without --no-optional (or --omit=optional).\n"
        : `discord-mcp: no prebuilt binary for ${target}. Supported: ${SUPPORTED.join(", ")}. ` +
            "Build from source with `cargo install el4cteo-discord-mcp` and run `discord-mcp`.\n",
    );
    process.exit(1);
  }
}

const child = spawn(binaryPath(), process.argv.slice(2), { stdio: "inherit", windowsHide: true });

// Forward termination so the binary can close its gateway socket cleanly.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}

child.on("error", (error) => {
  process.stderr.write(`discord-mcp: could not start the binary: ${error.message}\n`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
