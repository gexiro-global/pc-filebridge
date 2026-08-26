import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);

const blockedPaths = [
  /(^|\/)\.app\.json$/i,
  /(^|\/)roots\.local\.json$/i,
  /(^|\/)private(\/|$)/i,
  /(^|\/)\.env(?!\.example$)/i,
  /\.(?:jks|key|kdbx|keystore|p12|pem|pfx|ppk)$/i,
];

const blockedContent = [
  ["OpenAI key", new RegExp("\\b" + "sk-" + "(?:proj-)?[A-Za-z0-9_-]{16,}\\b", "g")],
  ["GitHub token", new RegExp("\\b" + "gh" + "[pousr]_[A-Za-z0-9]{20,}\\b", "g")],
  ["private key block", new RegExp("-----BEGIN " + "(?:RSA |OPENSSH |EC |DSA |ENCRYPTED )?PRIVATE KEY-----", "g")],
  ["real tunnel id", /\btunnel_[A-Za-z0-9_-]{8,}\b/g],
  ["private ChatGPT app id", /\basdk_app_[A-Za-z0-9_-]+\b/g],
  ["local Windows account", new RegExp("Hacking" + "_" + "Base", "gi")],
  ["private Gitea host", /git\.affihub\.site/gi],
];

const findings = [];
for (const file of tracked) {
  const portable = file.split(path.sep).join("/");
  if (blockedPaths.some((pattern) => pattern.test(portable))) {
    findings.push(`${portable}: blocked path`);
    continue;
  }
  const bytes = readFileSync(file);
  if (bytes.includes(0)) continue;
  const text = bytes.toString("utf8");
  for (const [label, pattern] of blockedContent) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) findings.push(`${portable}: ${label}`);
  }
}

if (findings.length > 0) {
  process.stderr.write(`SECRET_SCAN_FAIL findings=${findings.length}\n${findings.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`SECRET_SCAN_PASS files=${tracked.length}\n`);
}
