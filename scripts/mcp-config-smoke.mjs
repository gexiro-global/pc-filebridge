#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = process.env.FILEBRIDGE_CONFIG;
if (!configPath) throw new Error("FILEBRIDGE_CONFIG is required.");
const expectedRoots = (process.env.PCFB_EXPECTED_ROOTS ?? "").split(",").filter(Boolean).sort();
const child = spawn(process.execPath, [path.join(pluginRoot, "mcp", "server.mjs")], {
  cwd: pluginRoot,
  env: {
    ...process.env,
    FILEBRIDGE_CONFIG: configPath,
    FILEBRIDGE_ALLOW_DRIVE_ROOT: process.env.FILEBRIDGE_ALLOW_DRIVE_ROOT ?? "",
  },
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

let nextId = 1;
let stderr = "";
const pending = new Map();
const lines = readline.createInterface({ input: child.stdout });
lines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === undefined || message.id === null) return;
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.error) waiter.reject(new Error(`MCP_ERROR_${message.error.code}`));
  else waiter.resolve(message.result);
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr = (stderr + chunk).slice(-8192);
});

function send(message) {
  child.stdin.write(JSON.stringify(message) + "\n");
}

function request(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP_REQUEST_TIMEOUT_${method}`));
    }, 10000);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

try {
  await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "pc-filebridge-config-smoke", version: "0.2.2" },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });

  const catalog = await request("tools/list");
  const actualTools = catalog.tools.map((tool) => tool.name).sort();
  const expectedTools = ["create_directory", "create_text_file", "list_directory", "list_roots", "read_text_file", "search_file_names", "stat_path"];
  if (JSON.stringify(actualTools) !== JSON.stringify(expectedTools)) throw new Error("MCP_TOOL_CATALOG_MISMATCH");

  const response = await request("tools/call", { name: "list_roots", arguments: {} });
  if (response.isError) throw new Error("MCP_LIST_ROOTS_FAILED");
  const roots = (response.structuredContent?.roots ?? []).map((root) => root.id).sort();
  if (JSON.stringify(roots) !== JSON.stringify(expectedRoots)) throw new Error("MCP_ROOT_CONTRACT_MISMATCH");
  process.stdout.write(JSON.stringify({ tools: actualTools.length, root_ids: roots }) + "\n");
} catch (error) {
  if (stderr) process.stderr.write(stderr);
  throw error;
} finally {
  lines.close();
  child.stdin.end();
  if (!child.killed) child.kill();
}
