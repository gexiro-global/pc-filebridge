#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const healthcheckPath = path.join(pluginRoot, "deploy", "docker", "healthcheck.mjs");

const currentServer = await startMetricsServer("current");
try {
  runHealthcheck(currentServer.address);
} finally {
  currentServer.stop();
}

const staleServer = await startMetricsServer("stale");
try {
  let rejected = false;
  try {
    runHealthcheck(staleServer.address);
  } catch (error) {
    rejected = String(error.stderr ?? "").includes("PC_FILEBRIDGE_HEALTH_FAIL code=POLL_SUCCESS_STALE");
  }
  if (!rejected) throw new Error("Tunnel healthcheck accepted a stale successful poll.");
} finally {
  staleServer.stop();
}

process.stdout.write("HEALTHCHECK_SMOKE_PASS current=healthy stale=fail_closed\n");

function runHealthcheck(address) {
  execFileSync(process.execPath, [healthcheckPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      HEALTH_LISTEN_ADDR: address,
      TUNNEL_HEALTH_MAX_AGE_SECONDS: "180",
    },
    stdio: "pipe",
  });
}

async function startMetricsServer(mode) {
  const source = `
    const http = require("node:http");
    const mode = process.argv[1];
    const server = http.createServer((request, response) => {
      if (request.url === "/readyz") {
        response.writeHead(200).end("ready");
        return;
      }
      if (request.url === "/metrics") {
        const timestamp = mode === "current" ? Date.now() / 1000 : 1;
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("commands_poll_last_successful_timestamp_seconds " + timestamp + "\\n");
        return;
      }
      response.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      process.stdout.write("127.0.0.1:" + address.port + "\\n");
    });
  `;
  const child = spawn(process.execPath, ["-e", source, mode], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const address = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.stderr.once("data", (chunk) => reject(new Error(String(chunk))));
    child.stdout.once("data", (chunk) => resolve(String(chunk).trim()));
  });
  return {
    address,
    stop: () => child.kill("SIGTERM"),
  };
}
