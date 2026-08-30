#!/usr/bin/env node

import { readFileSync } from "node:fs";

const configPath = process.argv[2];
if (!configPath) throw new Error("CONFIG_PATH_REQUIRED");

const config = JSON.parse(readFileSync(configPath, "utf8"));
const expectedPaths = new Map([
  ["primary-data", "/data/primary"],
  ["secondary-data", "/data/secondary"],
  ["agent-data", "/data/agent"],
]);
const requiredIds = ["primary-data", "secondary-data"];

if (config.version !== 1 || !Array.isArray(config.roots)) {
  throw new Error("INFRASTRUCTURE_CONFIG_INVALID");
}
const configuredIds = config.roots.map((entry) => String(entry.id));
if (new Set(configuredIds).size !== configuredIds.length) {
  throw new Error("INFRASTRUCTURE_ROOT_DUPLICATE");
}
for (const requiredId of requiredIds) {
  if (!configuredIds.includes(requiredId)) throw new Error("INFRASTRUCTURE_ROOT_REQUIRED");
}
const expectedOrder = [...expectedPaths.keys()].filter((rootId) => configuredIds.includes(rootId));
if (JSON.stringify(configuredIds) !== JSON.stringify(expectedOrder)) {
  throw new Error("INFRASTRUCTURE_ROOT_ORDER_INVALID");
}
for (const entry of config.roots) {
  const expectedPath = expectedPaths.get(String(entry.id));
  if (!expectedPath || entry.path !== expectedPath) {
    throw new Error("INFRASTRUCTURE_ROOT_PATH_INVALID");
  }
  if (entry.read !== true || entry.create !== true) {
    throw new Error("INFRASTRUCTURE_ROOT_POLICY_INVALID");
  }
}

process.stdout.write(
  `INFRASTRUCTURE_ROLE_CONFIG_PASS roots=${configuredIds.length} agent=${configuredIds.includes("agent-data")}\n`,
);
