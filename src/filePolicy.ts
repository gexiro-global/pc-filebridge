import { createHash } from "node:crypto";
import { open, lstat, mkdir, opendir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import { z } from "zod";

const RootConfigSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  label: z.string().min(1).max(80),
  path: z.string().min(1),
  read: z.boolean(),
  create: z.boolean(),
}).strict();

const LimitsSchema = z.object({
  maxReadBytes: z.number().int().min(1024).max(1024 * 1024).default(256 * 1024),
  maxWriteBytes: z.number().int().min(1024).max(4 * 1024 * 1024).default(1024 * 1024),
  maxDirectoryEntries: z.number().int().min(1).max(1000).default(250),
  maxSearchResults: z.number().int().min(1).max(250).default(100),
  maxSearchEntries: z.number().int().min(100).max(25_000).default(5000),
}).strict();

export const FileBridgeConfigSchema = z.object({
  version: z.literal(1),
  roots: z.array(RootConfigSchema).min(1).max(16),
  limits: LimitsSchema,
}).strict();

export type FileBridgeConfig = z.infer<typeof FileBridgeConfigSchema>;
type RootConfig = z.infer<typeof RootConfigSchema>;
type Limits = z.infer<typeof LimitsSchema>;

interface RuntimeRoot extends RootConfig {
  canonicalPath: string;
}

export class PolicyError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

const BLOCKED_SEGMENTS = new Set([
  "$recycle.bin",
  ".agents",
  ".aws",
  ".azure",
  ".codex",
  ".docker",
  ".git",
  ".gnupg",
  ".kube",
  ".password-store",
  ".ssh",
  "appdata",
  "boot",
  "node_modules",
  "program files",
  "program files (x86)",
  "programdata",
  "recovery",
  "system volume information",
  "windows",
]);

const BLOCKED_FILENAMES = new Set([
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".pypirc",
  "cookies",
  "credentials",
  "credentials.json",
  "id_ed25519",
  "id_rsa",
  "local state",
  "login data",
  "secrets.json",
  "web data",
  "wallet.dat",
]);

const BLOCKED_EXTENSIONS = new Set([
  ".jks",
  ".key",
  ".kdbx",
  ".keystore",
  ".ovpn",
  ".p12",
  ".p8",
  ".pem",
  ".pfx",
  ".pk8",
  ".ppk",
]);
const SSH_PRIVATE_KEY_FILENAME = /^id_(?:rsa|dsa|ecdsa|ed25519)(?:[._-].*)?$/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const DRIVE_ROOT_OPT_IN = "I_ACCEPT_FULL_DRIVE_ACCESS_RISK";

export interface ReadTextResult {
  root_id: string;
  path: string;
  bytes_returned: number;
  file_bytes: number;
  truncated: boolean;
  sha256_returned: string;
  redactions: number;
  text: string;
}

export class FileBridgePolicy {
  private constructor(
    private readonly roots: Map<string, RuntimeRoot>,
    readonly limits: Limits,
  ) {}

  static async fromFile(configPath: string, driveRootOptIn = process.env.FILEBRIDGE_ALLOW_DRIVE_ROOT): Promise<FileBridgePolicy> {
    let raw: string;
    try {
      raw = await readFile(configPath, "utf8");
    } catch {
      throw new PolicyError("CONFIG_UNAVAILABLE", "FileBridge configuration is unavailable.");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new PolicyError("CONFIG_INVALID", "FileBridge configuration is not valid JSON.");
    }
    return FileBridgePolicy.fromConfig(FileBridgeConfigSchema.parse(parsed), driveRootOptIn);
  }

  static async fromConfig(config: FileBridgeConfig, driveRootOptIn?: string): Promise<FileBridgePolicy> {
    const validated = FileBridgeConfigSchema.parse(config);
    const roots = new Map<string, RuntimeRoot>();

    for (const configured of validated.roots) {
      if (roots.has(configured.id)) {
        throw new PolicyError("CONFIG_DUPLICATE_ROOT", "Root identifiers must be unique.");
      }

      let canonicalPath: string;
      try {
        canonicalPath = await realpath(path.resolve(configured.path));
        const info = await lstat(canonicalPath);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("not a real directory");
      } catch {
        throw new PolicyError("CONFIG_ROOT_UNAVAILABLE", `Configured root '${configured.id}' is unavailable.`);
      }

      if (isFilesystemRoot(canonicalPath) && driveRootOptIn !== DRIVE_ROOT_OPT_IN) {
        throw new PolicyError(
          "DRIVE_ROOT_NOT_APPROVED",
          `Root '${configured.id}' points at a complete filesystem. Explicit risk opt-in is required.`,
        );
      }

      roots.set(configured.id, { ...configured, canonicalPath });
    }

    return new FileBridgePolicy(roots, validated.limits);
  }

  listRoots(): Array<{ id: string; label: string; read: boolean; create: boolean; full_drive: boolean }> {
    return [...this.roots.values()].map((root) => ({
      id: root.id,
      label: root.label,
      read: root.read,
      create: root.create,
      full_drive: isFilesystemRoot(root.canonicalPath),
    }));
  }

  async statPath(rootId: string, relativePath: string) {
    const resolved = await this.resolveForRead(rootId, relativePath);
    const info = await lstat(resolved.target);
    if (info.isSymbolicLink()) throw new PolicyError("LINK_BLOCKED", "Links and junctions are blocked.");
    return {
      root_id: rootId,
      path: logicalPath(relativePath),
      kind: info.isFile() ? "file" : info.isDirectory() ? "directory" : "other",
      size: info.size,
      modified_at: info.mtime.toISOString(),
    };
  }

  async listDirectory(rootId: string, relativePath: string, requestedLimit?: number) {
    const resolved = await this.resolveForRead(rootId, relativePath);
    const directoryInfo = await lstat(resolved.target);
    if (!directoryInfo.isDirectory()) throw new PolicyError("NOT_A_DIRECTORY", "The requested path is not a directory.");

    const limit = Math.min(requestedLimit ?? this.limits.maxDirectoryEntries, this.limits.maxDirectoryEntries);
    const entries: Array<{ name: string; kind: "file" | "directory" | "other" }> = [];
    let blocked_entries = 0;
    let truncated = false;
    const directory = await opendir(resolved.target);
    for await (const entry of directory) {
      if (isBlockedPart(entry.name) || entry.isSymbolicLink()) {
        blocked_entries += 1;
        continue;
      }
      if (entries.length >= limit) {
        truncated = true;
        break;
      }
      entries.push({
        name: entry.name,
        kind: entry.isFile() ? "file" : entry.isDirectory() ? "directory" : "other",
      });
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    return { root_id: rootId, path: logicalPath(relativePath), entries, blocked_entries, truncated };
  }

  async readTextFile(rootId: string, relativePath: string, requestedMaxBytes?: number): Promise<ReadTextResult> {
    const resolved = await this.resolveForRead(rootId, relativePath);
    const before = await lstat(resolved.target);
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new PolicyError("NOT_A_REGULAR_FILE", "Only regular files can be read.");
    }

    const limit = Math.min(requestedMaxBytes ?? this.limits.maxReadBytes, this.limits.maxReadBytes);
    const handle = await open(resolved.target, "r");
    try {
      const after = await handle.stat();
      if (!after.isFile() || !sameFile(before, after)) {
        throw new PolicyError("PATH_CHANGED", "The file changed while it was being opened.");
      }
      const bytesToRead = Math.min(after.size, limit);
      const buffer = Buffer.alloc(bytesToRead);
      const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0);
      const returned = buffer.subarray(0, bytesRead);
      const text = decodeUtf8(returned, after.size > bytesRead);
      const redacted = redactSecrets(text);
      return {
        root_id: rootId,
        path: logicalPath(relativePath),
        bytes_returned: bytesRead,
        file_bytes: after.size,
        truncated: after.size > bytesRead,
        sha256_returned: createHash("sha256").update(returned).digest("hex"),
        redactions: redacted.count,
        text: redacted.text,
      };
    } finally {
      await handle.close();
    }
  }

  async searchNames(rootId: string, query: string, startPath = "") {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) throw new PolicyError("INVALID_QUERY", "Search query cannot be empty.");
    const start = await this.resolveForRead(rootId, startPath);
    const startInfo = await lstat(start.target);
    if (!startInfo.isDirectory()) throw new PolicyError("NOT_A_DIRECTORY", "Search start path is not a directory.");

    const queue = [logicalPath(startPath) === "." ? "" : logicalPath(startPath)];
    const matches: Array<{ path: string; kind: "file" | "directory" | "other" }> = [];
    let scanned_entries = 0;
    let blocked_entries = 0;
    let skipped_directories = 0;

    while (queue.length > 0 && scanned_entries < this.limits.maxSearchEntries && matches.length < this.limits.maxSearchResults) {
      const currentLogical = queue.shift() ?? "";
      const current = await this.resolveForRead(rootId, currentLogical);
      let directory;
      try {
        directory = await opendir(current.target);
      } catch {
        skipped_directories += 1;
        continue;
      }

      for await (const entry of directory) {
        scanned_entries += 1;
        if (isBlockedPart(entry.name) || entry.isSymbolicLink()) {
          blocked_entries += 1;
          continue;
        }
        const child = currentLogical ? `${currentLogical}/${entry.name}` : entry.name;
        const kind = entry.isFile() ? "file" : entry.isDirectory() ? "directory" : "other";
        if (entry.name.toLocaleLowerCase().includes(normalizedQuery)) matches.push({ path: child, kind });
        if (entry.isDirectory()) queue.push(child);
        if (scanned_entries >= this.limits.maxSearchEntries || matches.length >= this.limits.maxSearchResults) break;
      }
    }

    return {
      root_id: rootId,
      query,
      matches,
      scanned_entries,
      blocked_entries,
      skipped_directories,
      truncated: queue.length > 0 || matches.length >= this.limits.maxSearchResults,
    };
  }

  async createDirectory(rootId: string, relativePath: string) {
    const resolved = await this.resolveForCreate(rootId, relativePath);
    if (!resolved.normalizedRelative) throw new PolicyError("ROOT_WRITE_BLOCKED", "The configured root cannot be created or replaced.");
    await this.assertCreateParent(resolved.root, resolved.target);
    try {
      await mkdir(resolved.target, { recursive: false });
    } catch (error) {
      throw translateCreateError(error);
    }
    return { root_id: rootId, path: logicalPath(relativePath), created: true, kind: "directory" as const };
  }

  async createTextFile(rootId: string, relativePath: string, content: string) {
    const resolved = await this.resolveForCreate(rootId, relativePath);
    if (!resolved.normalizedRelative) throw new PolicyError("ROOT_WRITE_BLOCKED", "The configured root cannot be created or replaced.");
    if (content.includes("\u0000")) throw new PolicyError("BINARY_CONTENT_BLOCKED", "Only UTF-8 text content is accepted.");
    const data = Buffer.from(content, "utf8");
    if (data.byteLength > this.limits.maxWriteBytes) {
      throw new PolicyError("WRITE_LIMIT_EXCEEDED", `New file content exceeds the ${this.limits.maxWriteBytes}-byte limit.`);
    }
    await this.assertCreateParent(resolved.root, resolved.target);

    let handle;
    try {
      handle = await open(resolved.target, "wx", 0o600);
    } catch (error) {
      throw translateCreateError(error);
    }
    try {
      await handle.writeFile(data);
      await handle.sync();
    } catch {
      throw new PolicyError(
        "WRITE_INCOMPLETE",
        "Writing failed. A partial new file may exist; FileBridge will not delete it automatically.",
      );
    } finally {
      await handle.close();
    }

    return {
      root_id: rootId,
      path: logicalPath(relativePath),
      created: true,
      kind: "file" as const,
      bytes: data.byteLength,
      sha256: createHash("sha256").update(data).digest("hex"),
    };
  }

  private getRoot(rootId: string, operation: "read" | "create"): RuntimeRoot {
    const root = this.roots.get(rootId);
    if (!root) throw new PolicyError("ROOT_NOT_ALLOWED", "The requested root is not configured.");
    if (operation === "read" && !root.read) throw new PolicyError("READ_NOT_ALLOWED", "Read access is disabled for this root.");
    if (operation === "create" && !root.create) throw new PolicyError("CREATE_NOT_ALLOWED", "Create access is disabled for this root.");
    return root;
  }

  private async resolveForRead(rootId: string, relativePath: string) {
    const root = this.getRoot(rootId, "read");
    const resolved = resolveLogicalPath(root, relativePath);
    await assertNoLinks(root.canonicalPath, resolved.target);
    let canonicalTarget: string;
    try {
      canonicalTarget = await realpath(resolved.target);
    } catch {
      throw new PolicyError("PATH_NOT_FOUND", "The requested path does not exist.");
    }
    if (!isWithin(root.canonicalPath, canonicalTarget)) throw new PolicyError("PATH_ESCAPE_BLOCKED", "Path escapes the configured root.");
    return resolved;
  }

  private async resolveForCreate(rootId: string, relativePath: string) {
    const root = this.getRoot(rootId, "create");
    const resolved = resolveLogicalPath(root, relativePath);
    await assertNoLinks(root.canonicalPath, path.dirname(resolved.target));
    return resolved;
  }

  private async assertCreateParent(root: RuntimeRoot, target: string): Promise<void> {
    const parent = path.dirname(target);
    let canonicalParent: string;
    try {
      canonicalParent = await realpath(parent);
      const parentInfo = await lstat(parent);
      if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new Error("unsafe parent");
    } catch {
      throw new PolicyError("PARENT_UNAVAILABLE", "The parent directory must already exist and cannot be a link.");
    }
    if (!isWithin(root.canonicalPath, canonicalParent)) throw new PolicyError("PATH_ESCAPE_BLOCKED", "Parent escapes the configured root.");
  }
}

function resolveLogicalPath(root: RuntimeRoot, relativePath: string) {
  const normalizedRelative = validateRelativePath(relativePath);
  const target = path.resolve(root.canonicalPath, normalizedRelative || ".");
  if (!isWithin(root.canonicalPath, target)) throw new PolicyError("PATH_ESCAPE_BLOCKED", "Path escapes the configured root.");
  return { root, target, normalizedRelative };
}

function validateRelativePath(input: string): string {
  if (typeof input !== "string" || input.includes("\u0000")) throw new PolicyError("INVALID_PATH", "Path is invalid.");
  if (path.isAbsolute(input) || path.win32.isAbsolute(input) || path.posix.isAbsolute(input)) {
    throw new PolicyError("ABSOLUTE_PATH_BLOCKED", "Use a configured root id and a relative path.");
  }
  const parts = input.split(/[\\/]+/).filter(Boolean);
  for (const part of parts) {
    if (part === "." || part === "..") throw new PolicyError("PATH_TRAVERSAL_BLOCKED", "Dot segments are not allowed.");
    if (/[<>:"|?*\u0000-\u001f]/u.test(part) || /[. ]$/u.test(part) || WINDOWS_RESERVED.test(part)) {
      throw new PolicyError("INVALID_PATH_COMPONENT", "Path contains a blocked Windows path component.");
    }
    if (isBlockedPart(part)) throw new PolicyError("SENSITIVE_PATH_BLOCKED", "Sensitive credential or system paths are blocked.");
  }
  return parts.join(path.sep);
}

function isBlockedPart(part: string): boolean {
  const lower = part.toLocaleLowerCase();
  return BLOCKED_SEGMENTS.has(lower)
    || BLOCKED_FILENAMES.has(lower)
    || SSH_PRIVATE_KEY_FILENAME.test(lower)
    || lower.startsWith(".env")
    || BLOCKED_EXTENSIONS.has(path.extname(lower));
}

async function assertNoLinks(root: string, target: string): Promise<void> {
  if (!isWithin(root, target)) throw new PolicyError("PATH_ESCAPE_BLOCKED", "Path escapes the configured root.");
  const relative = path.relative(root, target);
  const parts = relative ? relative.split(path.sep) : [];
  let current = root;
  for (const part of ["", ...parts]) {
    if (part) current = path.join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new PolicyError("LINK_BLOCKED", "Links and junctions are blocked.");
    } catch (error) {
      if (error instanceof PolicyError) throw error;
      if (isNodeError(error) && error.code === "ENOENT") return;
      throw new PolicyError("PATH_UNAVAILABLE", "A path component is unavailable.");
    }
  }
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isFilesystemRoot(value: string): boolean {
  const resolved = path.resolve(value);
  return resolved.toLocaleLowerCase() === path.parse(resolved).root.toLocaleLowerCase();
}

function logicalPath(value: string): string {
  const normalized = validateRelativePath(value);
  return normalized ? normalized.split(path.sep).join("/") : ".";
}

function sameFile(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  if (left.ino === 0 || right.ino === 0) return true;
  return left.dev === right.dev && left.ino === right.ino;
}

function decodeUtf8(buffer: Buffer, truncated: boolean): string {
  for (let trim = 0; trim <= (truncated ? 3 : 0); trim += 1) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, buffer.length - trim));
    } catch {
      // A bounded read may end in the middle of one UTF-8 sequence. Try the prior boundary.
    }
  }
  throw new PolicyError("NON_TEXT_FILE", "The requested file is not valid UTF-8 text.");
}

function redactSecrets(input: string): { text: string; count: number } {
  let text = input;
  let count = 0;
  const replace = (pattern: RegExp, replacement: string | ((...values: string[]) => string)) => {
    text = text.replace(pattern, (...values: string[]) => {
      count += 1;
      return typeof replacement === "string" ? replacement : replacement(...values);
    });
  };
  replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/g, "[REDACTED_SECRET]");
  replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_SECRET]");
  replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED_SECRET]");
  replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_SECRET]");
  replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer [REDACTED_SECRET]");
  replace(/\b(password|passwd|secret|api[_-]?key|token)\s*([:=])\s*([^\s\"',;]{8,})/gi,
    (_match, name, separator) => `${name}${separator}[REDACTED_SECRET]`);
  return { text, count };
}

function translateCreateError(error: unknown): PolicyError {
  if (isNodeError(error) && error.code === "EEXIST") {
    return new PolicyError("TARGET_EXISTS", "Target already exists. FileBridge never overwrites existing paths.");
  }
  if (isNodeError(error) && error.code === "ENOENT") {
    return new PolicyError("PARENT_UNAVAILABLE", "The parent directory must already exist.");
  }
  if (isNodeError(error) && (error.code === "EACCES" || error.code === "EPERM")) {
    return new PolicyError("CREATE_DENIED", "The operating system denied creation.");
  }
  return new PolicyError("CREATE_FAILED", "The new path could not be created.");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
