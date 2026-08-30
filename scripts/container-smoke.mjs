#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const image = process.env.FILEBRIDGE_IMAGE ?? "pc-filebridge:0.2.1";
const expectedTunnelVersion = "0.0.13";
const expectedNodeVersion = "v24.20.0";
const expectedTools = [
  "create_directory",
  "create_text_file",
  "list_directory",
  "list_roots",
  "read_text_file",
  "search_file_names",
  "stat_path",
];

const imageConfig = JSON.parse(execFileSync("docker", ["image", "inspect", image], { encoding: "utf8" }))[0]?.Config;
if (!imageConfig) throw new Error("Docker image configuration was unavailable.");
if (imageConfig.User !== "10001:10001") {
  throw new Error(`Unexpected image user: ${imageConfig.User}`);
}
const environment = new Set(imageConfig.Env ?? []);
if (!environment.has("LOG_LEVEL=warn")) {
  throw new Error("Container image does not default to warning-only tunnel logs.");
}
if (!environment.has("FILEBRIDGE_ROLE=infrastructure")) {
  throw new Error("Container image is not pinned to the infrastructure role.");
}
if (!environment.has("EXPECTED_TUNNEL_NAME=PC FileBridge - Infrastructure")) {
  throw new Error("Container image does not enforce the infrastructure tunnel name.");
}
const healthTest = imageConfig.Healthcheck?.Test ?? [];
if (!healthTest.includes("/usr/local/lib/pc-filebridge/healthcheck.mjs")) {
  throw new Error(`Container healthcheck is not tunnel-aware: ${JSON.stringify(healthTest)}`);
}

const nodeVersion = execFileSync("docker", ["run", "--rm", "--entrypoint", "node", image, "--version"], {
  encoding: "utf8",
}).trim();
if (nodeVersion !== expectedNodeVersion) {
  throw new Error(`Unexpected Node.js version: ${nodeVersion}`);
}

const roleConfigResult = execFileSync("docker", [
  "run", "--rm", "--entrypoint", "node", image,
  "/usr/local/lib/pc-filebridge/validate-role-config.mjs",
  "/app/config/roots.infrastructure.json",
], { encoding: "utf8" });
if (!roleConfigResult.includes("INFRASTRUCTURE_ROLE_CONFIG_PASS")) {
  throw new Error("Container image did not validate its infrastructure role configuration.");
}

execFileSync("docker", [
  "run", "--rm", "--entrypoint", "sh", image, "-c",
  "test ! -e /usr/local/lib/node_modules/npm && ! command -v npm && ! command -v npx",
], { stdio: "pipe" });

const version = execFileSync("docker", ["run", "--rm", "--entrypoint", "/usr/local/bin/tunnel-client", image, "--version"], {
  encoding: "utf8",
}).trim();
if (!version.includes(expectedTunnelVersion)) {
  throw new Error(`Unexpected tunnel-client version: ${version}`);
}

let failedClosed = false;
try {
  execFileSync("docker", ["run", "--rm", image], { encoding: "utf8", stdio: "pipe" });
} catch (error) {
  const stderr = String(error.stderr ?? "");
  failedClosed = stderr.includes("PC_FILEBRIDGE_STARTUP_FAIL code=API_KEY_UNAVAILABLE");
}
if (!failedClosed) throw new Error("Container did not fail closed when secrets were absent.");

const client = new Client({ name: "pc-filebridge-container-smoke", version: "0.2.1" });
const transport = new StdioClientTransport({
  command: "docker",
  args: [
    "run", "--rm", "-i",
    "--read-only",
    "--user", "10001:10001",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true",
    "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=16m,uid=10001,gid=10001,mode=0700",
    "--tmpfs", "/data/primary:rw,noexec,nosuid,nodev,size=16m,uid=10001,gid=10001,mode=0700",
    "--tmpfs", "/data/secondary:rw,noexec,nosuid,nodev,size=16m,uid=10001,gid=10001,mode=0700",
    "--entrypoint", "node",
    image,
    "/app/mcp/server.mjs",
  ],
});

try {
  await client.connect(transport);
  const catalog = await client.listTools();
  const actualTools = catalog.tools.map((tool) => tool.name).sort();
  if (JSON.stringify(actualTools) !== JSON.stringify(expectedTools)) {
    throw new Error(`Unexpected container MCP tool catalog: ${JSON.stringify(actualTools)}`);
  }
  if (actualTools.some((name) => /delete|overwrite|append|rename|move|remove|unlink/i.test(name))) {
    throw new Error("A forbidden mutation tool was exposed by the container.");
  }

  const filePath = "container-create-only-smoke.txt";
  const content = "PC FileBridge container create-only smoke";
  const first = await client.callTool({
    name: "create_text_file",
    arguments: { root_id: "primary-data", relative_path: filePath, content },
  });
  if (first.isError) throw new Error(`Initial container create failed: ${JSON.stringify(first)}`);

  const second = await client.callTool({
    name: "create_text_file",
    arguments: { root_id: "primary-data", relative_path: filePath, content: "must-not-replace" },
  });
  if (!second.isError || !JSON.stringify(second).includes("TARGET_EXISTS")) {
    throw new Error(`Repeated create did not fail with TARGET_EXISTS: ${JSON.stringify(second)}`);
  }

  const readBack = await client.callTool({
    name: "read_text_file",
    arguments: { root_id: "primary-data", relative_path: filePath, max_bytes: 4096 },
  });
  if (readBack.isError || !JSON.stringify(readBack).includes(content) || JSON.stringify(readBack).includes("must-not-replace")) {
    throw new Error("Container create-only bytes were not preserved.");
  }
} finally {
  await client.close();
}

process.stdout.write(`CONTAINER_SMOKE_PASS image=${image} node=${expectedNodeVersion} tunnel_client=${expectedTunnelVersion} healthcheck=tunnel-aware logs=warn package_manager=absent tools=7 forbidden_mutations=0 create_only=preserved missing_secrets=fail_closed\n`);
