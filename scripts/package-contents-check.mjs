#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run this check through npm so npm_execpath is available.");
const output = execFileSync(process.execPath, [npmCli, "pack", "--dry-run", "--json", "--ignore-scripts"], {
  cwd: new URL("..", import.meta.url),
  encoding: "utf8",
});
const report = JSON.parse(output);
const packageReports = Array.isArray(report) ? report : Object.values(report);
const files = new Set(packageReports[0]?.files?.map((entry) => entry.path) ?? []);
const required = [
  ".codex-plugin/plugin.json",
  ".mcp.json",
  "config/roots.example.json",
  "config/roots.server.example.json",
  "config/roots.pc.example.json",
  "config/roots.laptop.example.json",
  "config/roots.infrastructure.example.json",
  "config/tunnel-roles.json",
  "scripts/Connect-PCFileBridgeRoleTunnel.ps1",
  "scripts/Connect-PCFileBridgeRoleTunnel-Task.ps1",
  "scripts/Install-PCFileBridgeRoleAutostart.ps1",
  "scripts/Set-PCFileBridgeGate.ps1",
  "scripts/Start-PCFileBridgeVolumeMonitor.ps1",
  "scripts/Test-PCFileBridgeRoleConfig.ps1",
  "scripts/Update-PCFileBridgeVolumeConfig.ps1",
  "scripts/volume-discovery.windows.test.ps1",
  "deploy/docker/Dockerfile",
  "deploy/docker/THIRD_PARTY_NOTICES.md",
  "deploy/docker/compose.example.yml",
  "deploy/docker/compose.host-ca.example.yml",
  "deploy/docker/entrypoint.sh",
  "deploy/docker/healthcheck.mjs",
  "deploy/docker/validate-role-config.mjs",
  "docs/IMAGE_SECURITY.md",
  "docs/TUNNEL_ROLES.md",
  "docs/VPS_DEPLOYMENT.md",
  "mcp/server.mjs",
  "scripts/image-vulnerability-gate.mjs",
  "scripts/image-vulnerability-gate.test.mjs",
  "scripts/docker-role-config.test.mjs",
  "scripts/version-consistency.mjs",
  "scripts/run-image-vulnerability-gate.sh",
  "README.md",
  "SECURITY.md",
  "THREAT_MODEL.md",
];
const forbiddenPatterns = [
  /(^|\/)\.env(?:\.|$)/iu,
  /(^|\/)(?:credentials?|secrets?)(?:\.|\/|$)/iu,
  /(^|\/)config\/roots\.local\.json$/iu,
  /(^|\/)node_modules\//u,
  /(^|\/)test\//u,
  /(^|\/)src\//u,
  /(^|\/)docs\/PRIVATE_VPS_OPERATIONS\.md$/u,
  /\.bak$/iu,
  /\.(?:key|pem|p12|pfx|ppk)$/iu,
];
const missing = required.filter((name) => !files.has(name));
const forbidden = [...files].filter((name) => forbiddenPatterns.some((pattern) => pattern.test(name)));

if (missing.length > 0 || forbidden.length > 0) {
  process.stderr.write(`${JSON.stringify({ event: "package_contents_failed", missing, forbidden })}\n`);
  process.exit(1);
}

process.stdout.write(`PACKAGE_CONTENTS_PASS files=${files.size} required=${required.length} forbidden=0\n`);
