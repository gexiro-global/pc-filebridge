#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const allowed = new Set(["0BSD", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "MIT"]);
const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
const rejected = [];
let checked = 0;

for (const [packagePath, metadata] of Object.entries(lock.packages ?? {})) {
  if (!packagePath.includes("node_modules/") || metadata.dev === true) continue;
  checked += 1;
  const license = typeof metadata.license === "string" ? metadata.license : "MISSING";
  if (!allowed.has(license)) rejected.push({ package: packagePath.replace(/^.*node_modules\//u, ""), license });
}

if (checked === 0 || rejected.length > 0) {
  process.stderr.write(`${JSON.stringify({ event: "license_check_failed", checked, rejected })}\n`);
  process.exit(1);
}

process.stdout.write(`LICENSE_CHECK_PASS production_packages=${checked} allowed=${[...allowed].join(",")}\n`);
