#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const validator = path.join(root, "deploy", "docker", "validate-role-config.mjs");
const defaultConfig = path.join(root, "config", "roots.infrastructure.example.json");
const fixtureDir = mkdtempSync(path.join(tmpdir(), "pc-filebridge-role-config-"));

function run(configPath) {
  return execFileSync(process.execPath, [validator, configPath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function expectReject(name, config) {
  const fixture = path.join(fixtureDir, `${name}.json`);
  writeFileSync(fixture, JSON.stringify(config), "utf8");
  try {
    run(fixture);
  } catch {
    return;
  }
  throw new Error(`Unsafe infrastructure config was accepted: ${name}`);
}

try {
  const base = JSON.parse(readFileSync(defaultConfig, "utf8"));
  if (!run(defaultConfig).includes("INFRASTRUCTURE_ROLE_CONFIG_PASS")) {
    throw new Error("Default infrastructure config did not pass.");
  }

  const withNode1 = structuredClone(base);
  withNode1.roots.push({
    id: "agent-data",
    label: "remote agent infrastructure data",
    path: "/data/agent",
    read: true,
    create: true,
  });
  const agentFixture = path.join(fixtureDir, "with-agent.json");
  writeFileSync(agentFixture, JSON.stringify(withNode1), "utf8");
  if (!run(agentFixture).includes("agent=true")) {
    throw new Error("Authorized optional remote agent config did not pass.");
  }

  const wrongPath = structuredClone(base);
  wrongPath.roots[0].path = "/etc";
  expectReject("wrong-path", wrongPath);

  const missingRequired = structuredClone(base);
  missingRequired.roots = missingRequired.roots.filter((entry) => entry.id !== "secondary-data");
  expectReject("missing-required", missingRequired);

  const crossRole = structuredClone(base);
  crossRole.roots[0].id = "pc-c";
  expectReject("cross-role", crossRole);

  const writablePolicyMissing = structuredClone(base);
  writablePolicyMissing.roots[0].create = false;
  expectReject("policy-mismatch", writablePolicyMissing);
} finally {
  rmSync(fixtureDir, { recursive: true, force: true });
}

process.stdout.write(
  "DOCKER_ROLE_CONFIG_TEST_PASS default=pass agent_optional=pass wrong_path=blocked missing_required=blocked cross_role=blocked policy_mismatch=blocked\n",
);
