#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";

const options = parseArguments(process.argv.slice(2));
const tag = requireOption(options, "tag");
const releaseDirectory = resolve(requireOption(options, "release-dir"));
const expectedVersion = tag.startsWith("v") ? tag.slice(1) : "";

if (!/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(tag)) fail(`Invalid release tag: ${tag}`);

const artifactNames = {
  runtime: `pc-filebridge-${tag}-runtime-npm.tgz`,
  source: `pc-filebridge-${tag}-source.tar.gz`,
  sbom: `pc-filebridge-${tag}-sbom.cdx.json`,
};
const artifactPaths = Object.fromEntries(
  Object.entries(artifactNames).map(([key, value]) => [key, join(releaseDirectory, value)]),
);
const checksumPath = join(releaseDirectory, "SHA256SUMS");
const temporaryRoot = await mkdtemp(join(tmpdir(), "pc-filebridge-release-receiver-"));

try {
  for (const filePath of [...Object.values(artifactPaths), checksumPath]) {
    if (!existsSync(filePath)) fail(`Missing release file: ${basename(filePath)}`);
  }
  await verifyChecksums(checksumPath, artifactNames, artifactPaths);
  await verifySbom(artifactPaths.sbom, expectedVersion);
  await verifyRuntimePackage(artifactPaths.runtime, expectedVersion, temporaryRoot);
  await verifySourceArchive(artifactPaths.source, expectedVersion, tag, temporaryRoot);
  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    tag,
    runtime_artifact: artifactNames.runtime,
    source_artifact: artifactNames.source,
    checksums: "MATCH",
    receiver_install: "PASS",
    receiver_mcp_smoke: "PASS",
    source_check: "PASS",
  }, null, 2)}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function verifyChecksums(filePath, names, paths) {
  const entries = new Map();
  for (const line of (await readFile(filePath, "utf8")).trim().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64}) {2}([^/\\]+)$/.exec(line);
    if (!match) fail("SHA256SUMS must contain lowercase hashes and basename-only paths.");
    entries.set(match[2], match[1]);
  }
  const expectedNames = Object.values(names);
  if (entries.size !== expectedNames.length || expectedNames.some((name) => !entries.has(name))) {
    fail("SHA256SUMS does not describe exactly the runtime, source, and SBOM artifacts.");
  }
  for (const [kind, artifactPath] of Object.entries(paths)) {
    const digest = createHash("sha256").update(await readFile(artifactPath)).digest("hex");
    if (entries.get(names[kind]) !== digest) fail(`Checksum mismatch: ${names[kind]}`);
  }
}

async function verifySbom(sbomPath, expectedVersion) {
  let sbom;
  try {
    sbom = JSON.parse(await readFile(sbomPath, "utf8"));
  } catch {
    fail("SBOM is not valid JSON.");
  }
  if (sbom.bomFormat !== "CycloneDX" || sbom.metadata?.component?.version !== expectedVersion) {
    fail("SBOM is not a CycloneDX document for the released package version.");
  }
}

async function verifyRuntimePackage(runtimePackage, expectedVersion, root) {
  const receiver = join(root, "runtime-receiver");
  await mkdir(receiver);
  await writeFile(join(receiver, "package.json"), '{"name":"pc-filebridge-release-receiver","private":true}\n');
  runNpm(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", runtimePackage], receiver);

  const installedRoot = join(receiver, "node_modules", "pc-filebridge");
  const installedManifest = JSON.parse(await readFile(join(installedRoot, "package.json"), "utf8"));
  if (installedManifest.version !== expectedVersion) {
    fail(`Installed runtime version ${installedManifest.version} does not match ${expectedVersion}.`);
  }
  for (const required of [
    ".codex-plugin/plugin.json",
    ".mcp.json",
    "mcp/server.mjs",
    "scripts/mcp-smoke.mjs",
    "skills/pc-filebridge/SKILL.md",
    "LICENSE",
  ]) {
    if (!existsSync(join(installedRoot, required))) fail(`Runtime package is missing ${required}.`);
  }
  await assertNoPrivateRuntimeEntries(installedRoot);
  run(process.execPath, [join(installedRoot, "scripts", "mcp-smoke.mjs")], receiver);
}

async function assertNoPrivateRuntimeEntries(installedRoot) {
  const entries = await listRelativeFiles(installedRoot);
  const forbidden = entries.filter((entry) =>
    entry === ".app.json"
    || entry === "config/roots.local.json"
    || /(?:^|\/)\.env(?!\.example$)/i.test(entry)
    || /(?:^|\/)private(?:\/|$)/i.test(entry)
    || /\.(?:jks|key|kdbx|keystore|p12|pem|pfx|ppk)$/i.test(entry),
  );
  if (forbidden.length) fail(`Runtime package contains prohibited private entries: ${forbidden.join(", ")}`);
}

async function verifySourceArchive(sourceArchive, expectedVersion, tag, root) {
  const extracted = join(root, "source-receiver");
  await mkdir(extracted);
  run("tar", ["-xzf", sourceArchive, "-C", extracted], root);

  const roots = await readdir(extracted, { withFileTypes: true });
  const directories = roots.filter((entry) => entry.isDirectory());
  if (directories.length !== 1 || roots.length !== 1) fail("Source archive must contain exactly one top-level directory.");
  const sourceRoot = join(extracted, directories[0].name);
  if (directories[0].name !== `pc-filebridge-${tag}-source`) fail("Source archive root name is not versioned as expected.");
  for (const required of [
    "package.json",
    "package-lock.json",
    "src",
    "test",
    "scripts",
    ".github/workflows",
    ".codex-plugin/plugin.json",
    "LICENSE",
  ]) {
    if (!existsSync(join(sourceRoot, required))) fail(`Source archive is missing ${required}.`);
  }
  const sourceManifest = JSON.parse(await readFile(join(sourceRoot, "package.json"), "utf8"));
  if (sourceManifest.version !== expectedVersion) {
    fail(`Source version ${sourceManifest.version} does not match ${expectedVersion}.`);
  }
  runNpm(["ci", "--ignore-scripts"], sourceRoot);
  runNpm(["run", "check"], sourceRoot);
}

async function listRelativeFiles(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await listRelativeFiles(join(directory, entry.name), relative)));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "pipe", maxBuffer: 20 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    const diagnostic = [result.error?.message, result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    fail(`${command} ${args.join(" ")} failed${diagnostic ? `:\n${diagnostic}` : "."}`);
  }
}

function runNpm(args, cwd) {
  if (process.platform !== "win32") return run("npm", args, cwd);
  const npmCli = process.env.npm_execpath || join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (!existsSync(npmCli)) fail("Unable to locate npm-cli.js for receiver verification.");
  run(process.execPath, [npmCli, ...args], cwd);
}

function parseArguments(args) {
  const result = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith("--") || value === undefined) fail(`Invalid argument near ${name ?? "<end>"}.`);
    result.set(name.slice(2), value);
  }
  return result;
}

function requireOption(options, name) {
  const value = options.get(name);
  if (!value) fail(`Missing --${name}.`);
  return value;
}

function fail(message) {
  throw new Error(message);
}
