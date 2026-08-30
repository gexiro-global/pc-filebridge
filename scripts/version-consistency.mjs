#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFile(path.join(root, relativePath), "utf8");
const packageJson = JSON.parse(await read("package.json"));
const packageLock = JSON.parse(await read("package-lock.json"));
const plugin = JSON.parse(await read(".codex-plugin/plugin.json"));
const version = packageJson.version;

if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new Error("Package version is not semantic.");
if (packageLock.version !== version || packageLock.packages?.[""]?.version !== version) {
  throw new Error("package-lock.json version does not match package.json.");
}
if (plugin.version !== version) throw new Error("Codex plugin version does not match package.json.");

const exactNeedles = new Map([
  ["src/server.ts", `version: "${version}"`],
  ["mcp/server.mjs", `version: "${version}"`],
  ["scripts/mcp-smoke.mjs", `version: "${version}"`],
  ["scripts/container-smoke.mjs", `version: "${version}"`],
  ["scripts/run-image-vulnerability-gate.sh", `pc-filebridge:${version}`],
  [".github/workflows/ci.yml", `pc-filebridge:${version}`],
  [".github/workflows/release.yml", `pc-filebridge:${version}`],
  ["deploy/docker/compose.example.yml", `pc-filebridge:${version}`],
  ["deploy/docker/Dockerfile", `ARG APP_VERSION=${version}`],
  ["README.md", `Version ${version}`],
  ["CHANGELOG.md", `## ${version} -`],
  ["docs/TUNNEL_ROLES.md", `PC FileBridge ${version}`],
]);
for (const [relativePath, needle] of exactNeedles) {
  const text = await read(relativePath);
  if (!text.includes(needle)) throw new Error(`Version mismatch in ${relativePath}.`);
}

process.stdout.write(`VERSION_CONSISTENCY_PASS version=${version} checked=${exactNeedles.size + 3}\n`);
