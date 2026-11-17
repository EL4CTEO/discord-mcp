// Builds the per-platform npm packages from the release binaries.
//
//   node npm/platforms.mjs <artifacts-dir> <out-dir>
//
// <artifacts-dir> holds one folder per target (discord-mcp-<target>/), each with
// the built binary. Every package gets os/cpu fields, so npm installs only the
// one matching the user's machine.
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [artifacts, out] = process.argv.slice(2);
if (!artifacts || !out) {
  console.error("usage: node npm/platforms.mjs <artifacts-dir> <out-dir>");
  process.exit(2);
}

const root = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const targets = [
  { npm: "win32-x64", rust: "x86_64-pc-windows-msvc", os: "win32", cpu: "x64", exe: "discord-mcp.exe" },
  { npm: "linux-x64", rust: "x86_64-unknown-linux-gnu", os: "linux", cpu: "x64", exe: "discord-mcp" },
  { npm: "linux-arm64", rust: "aarch64-unknown-linux-gnu", os: "linux", cpu: "arm64", exe: "discord-mcp" },
  { npm: "darwin-x64", rust: "x86_64-apple-darwin", os: "darwin", cpu: "x64", exe: "discord-mcp" },
  { npm: "darwin-arm64", rust: "aarch64-apple-darwin", os: "darwin", cpu: "arm64", exe: "discord-mcp" },
];

for (const t of targets) {
  const name = `@el4cteo/discord-mcp-${t.npm}`;
  if (root.optionalDependencies?.[name] !== root.version) {
    console.error(`package.json optionalDependencies must pin ${name} at ${root.version}`);
    process.exit(1);
  }
  const dir = join(out, t.npm);
  mkdirSync(join(dir, "bin"), { recursive: true });
  const binary = join(dir, "bin", t.exe);
  copyFileSync(join(artifacts, `discord-mcp-${t.rust}`, t.exe), binary);
  if (t.os !== "win32") chmodSync(binary, 0o755);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name,
        version: root.version,
        description: `The ${t.npm} binary for @el4cteo/discord-mcp.`,
        license: root.license,
        repository: root.repository,
        os: [t.os],
        cpu: [t.cpu],
        files: ["bin"],
        publishConfig: { access: "public" },
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(join(dir, "README.md"), `# ${name}\n\nThe ${t.npm} binary of [@el4cteo/discord-mcp](https://www.npmjs.com/package/@el4cteo/discord-mcp). Install that package instead.\n`);
  console.log(`built ${name}@${root.version}`);
}
