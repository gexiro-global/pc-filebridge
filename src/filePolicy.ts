import { createHash } from "node:crypto";
import { open, lstat, mkdir, opendir, readFile, realpath } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import { z } from "zod";

const RootConfigSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  label: z.string().min(1).max(80),
  path: z.string().min(1),
  read: z.boolean(),
  create: z.boolean(),
  host_id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/).optional(),
  volume_id: z.string().regex(/^vol-[a-f0-9]{16}$/).optional(),
  current_drive_letter: z.string().regex(/^[A-Z]$/).optional(),
  filesystem: z.string().min(1).max(32).optional(),
  bus_type: z.string().min(1).max(64).optional(),
  online: z.boolean().optional(),
  auto_discovered: z.boolean().optional(),
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
  roots: z.array(RootConfigSchema).min(1).max(26),
  limits: LimitsSchema,
}).strict();

export type FileBridgeConfig = z.infer<typeof FileBridgeConfigSchema>;
type RootConfig = z.infer<typeof RootConfigSchema>;
type Limits = z.infer<typeof LimitsSchema>;

interface RuntimeRoot extends RootConfig {
  canonicalPath: string;
  identity: FileIdentity;
}

type FileIdentity = Pick<BigIntStats, "dev" | "ino">;
type FileIdentityInput = { dev: number | bigint; ino: number | bigint };

interface AuthorizedExistingPath {
  target: string;
  info: BigIntStats;
  storedParts: string[];
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
const MAX_CANONICALIZATION_ENTRIES = 25_000;

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
      let rootInfo: BigIntStats;
      try {
        const authorized = await authorizeConfiguredRoot(configured.path);
        canonicalPath = authorized.target;
        rootInfo = authorized.info;
        if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("not a real directory");
      } catch (error) {
        if (error instanceof PolicyError) throw error;
        throw new PolicyError("CONFIG_ROOT_UNAVAILABLE", `Configured root '${configured.id}' is unavailable.`);
      }

      if (isFilesystemRoot(canonicalPath) && driveRootOptIn !== DRIVE_ROOT_OPT_IN) {
        throw new PolicyError(
          "DRIVE_ROOT_NOT_APPROVED",
          `Root '${configured.id}' points at a complete filesystem. Explicit risk opt-in is required.`,
        );
      }

      roots.set(configured.id, { ...configured, canonicalPath, identity: identityOf(rootInfo) });
    }

    return new FileBridgePolicy(roots, validated.limits);
  }

  listRoots(): Array<{
    id: string;
    label: string;
    read: boolean;
    create: boolean;
    full_drive: boolean;
    host_id?: string;
    volume_id?: string;
    current_drive_letter?: string;
    filesystem?: string;
    bus_type?: string;
    online?: boolean;
    auto_discovered?: boolean;
  }> {
    return [...this.roots.values()].map((root) => ({
      id: root.id,
      label: root.label,
      read: root.read,
      create: root.create,
      full_drive: isFilesystemRoot(root.canonicalPath),
      ...(root.host_id === undefined ? {} : { host_id: root.host_id }),
      ...(root.volume_id === undefined ? {} : { volume_id: root.volume_id }),
      ...(root.current_drive_letter === undefined ? {} : { current_drive_letter: root.current_drive_letter }),
      ...(root.filesystem === undefined ? {} : { filesystem: root.filesystem }),
      ...(root.bus_type === undefined ? {} : { bus_type: root.bus_type }),
      ...(root.online === undefined ? {} : { online: root.online }),
      ...(root.auto_discovered === undefined ? {} : { auto_discovered: root.auto_discovered }),
    }));
  }

  async statPath(rootId: string, relativePath: string) {
    const resolved = await this.resolveForRead(rootId, relativePath);
    const info = resolved.info;
    if (info.isSymbolicLink()) throw new PolicyError("LINK_BLOCKED", "Links and junctions are blocked.");
    await assertUnchanged(resolved.target, info);
    return {
      root_id: rootId,
      path: logicalPath(relativePath),
      kind: info.isFile() ? "file" : info.isDirectory() ? "directory" : "other",
      size: Number(info.size),
      modified_at: info.mtime.toISOString(),
    };
  }

  async listDirectory(rootId: string, relativePath: string, requestedLimit?: number) {
    const resolved = await this.resolveForRead(rootId, relativePath);
    const directoryInfo = resolved.info;
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
    await assertUnchanged(resolved.target, directoryInfo);
    entries.sort((left, right) => left.name.localeCompare(right.name));
    return { root_id: rootId, path: logicalPath(relativePath), entries, blocked_entries, truncated };
  }

  async readTextFile(rootId: string, relativePath: string, requestedMaxBytes?: number): Promise<ReadTextResult> {
    const resolved = await this.resolveForRead(rootId, relativePath);
    const before = resolved.info;
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new PolicyError("NOT_A_REGULAR_FILE", "Only regular files can be read.");
    }

    const limit = Math.min(requestedMaxBytes ?? this.limits.maxReadBytes, this.limits.maxReadBytes);
    const handle = await open(resolved.target, "r");
    try {
      const after = await handle.stat({ bigint: true });
      if (!after.isFile() || !sameFileIdentity(before, after)) {
        throw new PolicyError("PATH_CHANGED", "The file changed while it was being opened.");
      }
      const bytesToRead = Number(after.size < BigInt(limit) ? after.size : BigInt(limit));
      const buffer = Buffer.alloc(bytesToRead);
      const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0);
      const returned = buffer.subarray(0, bytesRead);
      const text = decodeUtf8(returned, after.size > BigInt(bytesRead));
      const redacted = redactSecrets(text);
      return {
        root_id: rootId,
        path: logicalPath(relativePath),
        bytes_returned: bytesRead,
        file_bytes: Number(after.size),
        truncated: after.size > BigInt(bytesRead),
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
    const startInfo = start.info;
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
    try {
      await mkdir(resolved.target, { recursive: false });
    } catch (error) {
      throw translateCreateError(error);
    }
    await assertUnchanged(resolved.parent.target, resolved.parent.info);
    try {
      await authorizeExistingPath(resolved.root, resolved.normalizedRelative);
    } catch {
      throw new PolicyError(
        "CREATE_INCOMPLETE",
        "The new directory was created but post-create authorization failed; FileBridge will not delete it automatically.",
      );
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
    let handle;
    try {
      handle = await open(resolved.target, "wx", 0o600);
    } catch (error) {
      throw translateCreateError(error);
    }
    try {
      const [opened, named] = await Promise.all([handle.stat({ bigint: true }), lstat(resolved.target, { bigint: true })]);
      if (!opened.isFile() || named.isSymbolicLink() || !sameFileIdentity(opened, named)) {
        throw new PolicyError("PATH_CHANGED", "The new file path changed while it was being opened.");
      }
      await assertUnchanged(resolved.parent.target, resolved.parent.info);
      await handle.writeFile(data);
      await handle.sync();
      const [written, finalNamed] = await Promise.all([handle.stat({ bigint: true }), lstat(resolved.target, { bigint: true })]);
      if (!written.isFile() || finalNamed.isSymbolicLink() || !sameFileIdentity(written, finalNamed)) {
        throw new PolicyError("PATH_CHANGED", "The new file path changed while it was being written.");
      }
      await assertUnchanged(resolved.parent.target, resolved.parent.info);
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
    const normalizedRelative = validateRelativePath(relativePath);
    const authorized = await authorizeExistingPath(root, normalizedRelative);
    return { root, normalizedRelative, ...authorized };
  }

  private async resolveForCreate(rootId: string, relativePath: string) {
    const root = this.getRoot(rootId, "create");
    const normalizedRelative = validateRelativePath(relativePath);
    const parts = splitNormalizedPath(normalizedRelative);
    if (parts.length === 0) {
      return {
        root,
        target: root.canonicalPath,
        normalizedRelative,
        parent: await authorizeExistingPath(root, ""),
      };
    }
    const leaf = parts.pop()!;
    const parentRelative = parts.join(path.sep);
    const parent = await authorizeExistingPath(root, parentRelative);
    if (!parent.info.isDirectory()) {
      throw new PolicyError("PARENT_UNAVAILABLE", "The parent directory must already exist and cannot be a link.");
    }
    const target = path.join(parent.target, leaf);
    if (!isWithin(root.canonicalPath, target)) throw new PolicyError("PATH_ESCAPE_BLOCKED", "Path escapes the configured root.");
    return { root, target, normalizedRelative, parent };
  }
}

function validateRelativePath(input: string): string {
  if (typeof input !== "string" || input.includes("\u0000")) throw new PolicyError("INVALID_PATH", "Path is invalid.");
  if (path.isAbsolute(input) || path.win32.isAbsolute(input) || path.posix.isAbsolute(input)) {
    throw new PolicyError("ABSOLUTE_PATH_BLOCKED", "Use a configured root id and a relative path.");
  }
  if ((input.includes("/") && input.includes("\\")) || /[\\/]{2,}/u.test(input)) {
    throw new PolicyError("AMBIGUOUS_PATH_BLOCKED", "Mixed or repeated path separators are not allowed.");
  }
  const parts = input.split(/[\\/]+/).filter(Boolean);
  for (const part of parts) {
    validatePathComponent(part);
  }
  return parts.join(path.sep);
}

function validatePathComponent(part: string): void {
  validatePathComponentSyntax(part);
  if (isBlockedPart(part)) throw new PolicyError("SENSITIVE_PATH_BLOCKED", "Sensitive credential or system paths are blocked.");
}

function validatePathComponentSyntax(part: string): void {
  if (part === "." || part === "..") throw new PolicyError("PATH_TRAVERSAL_BLOCKED", "Dot segments are not allowed.");
  if (/[<>:"|?*\u0000-\u001f]/u.test(part) || /[. ]$/u.test(part) || WINDOWS_RESERVED.test(part)) {
    throw new PolicyError("INVALID_PATH_COMPONENT", "Path contains a blocked Windows path component.");
  }
}

function isBlockedPart(part: string): boolean {
  const lower = part.toLocaleLowerCase();
  return BLOCKED_SEGMENTS.has(lower)
    || BLOCKED_FILENAMES.has(lower)
    || SSH_PRIVATE_KEY_FILENAME.test(lower)
    || lower.startsWith(".env")
    || BLOCKED_EXTENSIONS.has(path.extname(lower));
}

async function authorizeConfiguredRoot(configuredPath: string): Promise<AuthorizedExistingPath> {
  const absolute = path.resolve(configuredPath);
  const filesystemRoot = path.parse(absolute).root;
  const relative = path.relative(filesystemRoot, absolute);
  const parts = relative ? relative.split(path.sep) : [];
  for (const part of parts) validatePathComponentSyntax(part);

  let rootInfo: BigIntStats;
  try {
    rootInfo = await lstat(filesystemRoot, { bigint: true });
  } catch {
    throw new PolicyError("CONFIG_ROOT_UNAVAILABLE", "Configured root filesystem is unavailable.");
  }
  assertSafeObject(rootInfo);
  const result = await authorizeStoredComponents(
    filesystemRoot,
    rootInfo,
    parts,
    filesystemRoot,
    false,
    Math.max(parts.length - 1, 0),
  );
  if (!result.info.isDirectory()) {
    throw new PolicyError("CONFIG_ROOT_UNAVAILABLE", "Configured root must be a directory.");
  }
  if (result.storedParts.length > 0 && isBlockedPart(result.storedParts.at(-1)!)) {
    throw new PolicyError("SENSITIVE_PATH_BLOCKED", "A configured root cannot itself be a sensitive path.");
  }
  return result;
}

async function authorizeExistingPath(root: RuntimeRoot, normalizedRelative: string): Promise<AuthorizedExistingPath> {
  let rootInfo: BigIntStats;
  try {
    rootInfo = await lstat(root.canonicalPath, { bigint: true });
  } catch {
    throw new PolicyError("PATH_UNAVAILABLE", "The configured root is unavailable.");
  }
  assertSafeObject(rootInfo);
  if (!sameFileIdentity(root.identity, rootInfo)) {
    throw new PolicyError("PATH_CHANGED", "The configured root changed after startup.");
  }
  const parts = splitNormalizedPath(normalizedRelative);
  return authorizeStoredComponents(root.canonicalPath, rootInfo, parts, root.canonicalPath);
}

async function authorizeStoredComponents(
  start: string,
  startInfo: BigIntStats,
  suppliedParts: string[],
  boundary: string,
  enforceSensitiveNames = true,
  enforceAlternateFromIndex = 0,
): Promise<AuthorizedExistingPath> {
  let current = start;
  let currentInfo = startInfo;
  const storedParts: string[] = [];

  for (let partIndex = 0; partIndex < suppliedParts.length; partIndex += 1) {
    const suppliedPart = suppliedParts[partIndex]!;
    if (!currentInfo.isDirectory()) {
      throw new PolicyError("PATH_NOT_FOUND", "A parent path component is not a directory.");
    }
    const suppliedTarget = path.join(current, suppliedPart);
    if (!isWithin(boundary, suppliedTarget)) {
      throw new PolicyError("PATH_ESCAPE_BLOCKED", "Path escapes the configured root.");
    }

    let suppliedInfo: BigIntStats;
    try {
      suppliedInfo = await lstat(suppliedTarget, { bigint: true });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new PolicyError("PATH_NOT_FOUND", "The requested path does not exist.");
      }
      throw new PolicyError("PATH_UNAVAILABLE", "A path component is unavailable.");
    }
    assertSafeObject(suppliedInfo);

    const matches: Array<{ name: string; info: BigIntStats }> = [];
    let scanned = 0;
    let directory;
    try {
      directory = await opendir(current);
      for await (const entry of directory) {
        scanned += 1;
        if (scanned > MAX_CANONICALIZATION_ENTRIES) {
          throw new PolicyError("PATH_IDENTITY_UNAVAILABLE", "Directory identity mapping exceeded the safety bound.");
        }
        let candidateInfo: BigIntStats;
        try {
          candidateInfo = await lstat(path.join(current, entry.name), { bigint: true });
        } catch {
          continue;
        }
        if (!hasStableIdentity(candidateInfo)) continue;
        if (sameFileIdentity(suppliedInfo, candidateInfo)) matches.push({ name: entry.name, info: candidateInfo });
      }
    } finally {
      await directory?.close().catch(() => undefined);
    }

    await assertUnchanged(current, currentInfo);
    if (matches.length === 0) {
      throw new PolicyError("PATH_IDENTITY_UNAVAILABLE", "The stored path name could not be established safely.");
    }
    if (matches.length !== 1) {
      throw new PolicyError("PATH_IDENTITY_AMBIGUOUS", "Multiple stored names identify the same filesystem object.");
    }

    const stored = matches[0]!;
    if (enforceSensitiveNames && isBlockedPart(stored.name)) {
      throw new PolicyError("SENSITIVE_PATH_BLOCKED", "Sensitive credential or system paths are blocked.");
    }
    if (partIndex >= enforceAlternateFromIndex && !sameSpellingOrWindowsCase(suppliedPart, stored.name)) {
      throw new PolicyError("ALTERNATE_NAME_BLOCKED", "Alternate filesystem names are blocked.");
    }

    const storedTarget = path.join(current, stored.name);
    await assertUnchanged(storedTarget, suppliedInfo);
    const canonicalTarget = await realpath(storedTarget).catch(() => {
      throw new PolicyError("PATH_CHANGED", "A path component changed during canonicalization.");
    });
    if (!isWithin(boundary, canonicalTarget)) {
      throw new PolicyError("PATH_ESCAPE_BLOCKED", "Path escapes the configured root.");
    }
    await assertUnchanged(canonicalTarget, suppliedInfo);
    current = canonicalTarget;
    currentInfo = stored.info;
    storedParts.push(stored.name);
  }

  if (currentInfo.isFile() && currentInfo.nlink > 1n) {
    throw new PolicyError("HARDLINK_BLOCKED", "Files with multiple hard links are blocked.");
  }
  return { target: current, info: currentInfo, storedParts };
}

function splitNormalizedPath(value: string): string[] {
  return value ? value.split(path.sep) : [];
}

function sameSpellingOrWindowsCase(supplied: string, stored: string): boolean {
  if (supplied === stored) return true;
  return process.platform === "win32" && supplied.toLowerCase() === stored.toLowerCase();
}

function assertSafeObject(info: BigIntStats): void {
  if (info.isSymbolicLink()) throw new PolicyError("LINK_BLOCKED", "Links and junctions are blocked.");
  if (!info.isFile() && !info.isDirectory()) {
    throw new PolicyError("UNSUPPORTED_OBJECT_BLOCKED", "Unsupported filesystem objects and reparse points are blocked.");
  }
  assertStableIdentity(info);
}

function assertStableIdentity(info: FileIdentity): void {
  if (!hasStableIdentity(info)) {
    throw new PolicyError("PATH_IDENTITY_UNAVAILABLE", "Stable filesystem identity is unavailable.");
  }
}

function hasStableIdentity(info: FileIdentity): boolean {
  return info.dev >= 0n && info.ino > 0n;
}

function identityOf(info: FileIdentity): FileIdentity {
  assertStableIdentity(info);
  return { dev: info.dev, ino: info.ino };
}

async function assertUnchanged(target: string, expected: FileIdentity): Promise<void> {
  let current: BigIntStats;
  try {
    current = await lstat(target, { bigint: true });
  } catch {
    throw new PolicyError("PATH_CHANGED", "The path changed during authorization.");
  }
  assertSafeObject(current);
  if (!sameFileIdentity(expected, current)) {
    throw new PolicyError("PATH_CHANGED", "The path changed during authorization.");
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

export function sameFileIdentity(left: FileIdentityInput, right: FileIdentityInput): boolean {
  const leftDev = exactBigInt(left.dev);
  const leftIno = exactBigInt(left.ino);
  const rightDev = exactBigInt(right.dev);
  const rightIno = exactBigInt(right.ino);
  if (leftDev === null || leftIno === null || rightDev === null || rightIno === null
    || leftDev < 0n || rightDev < 0n || leftIno <= 0n || rightIno <= 0n) return false;
  return leftDev === rightDev && leftIno === rightIno;
}

function exactBigInt(value: number | bigint): bigint | null {
  if (typeof value === "bigint") return value;
  return Number.isSafeInteger(value) ? BigInt(value) : null;
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
