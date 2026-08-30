import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { FileBridgePolicy, type FileBridgeConfig, PolicyError, sameFileIdentity } from "../src/filePolicy.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

async function fixture() {
  const base = await mkdtemp(path.join(process.cwd(), ".pc-filebridge-test-"));
  cleanup.push(base);
  const root = path.join(base, "allowed");
  await mkdir(root);
  const config: FileBridgeConfig = {
    version: 1,
    roots: [{ id: "test", label: "Test root", path: root, read: true, create: true }],
    limits: {
      maxReadBytes: 4096,
      maxWriteBytes: 4096,
      maxDirectoryEntries: 50,
      maxSearchResults: 20,
      maxSearchEntries: 100,
    },
  };
  return { base, root, policy: await FileBridgePolicy.fromConfig(config) };
}

describe("create-only invariant", () => {
  test("creates a new file once and never changes an existing file", async () => {
    const { root, policy } = await fixture();
    await policy.createTextFile("test", "proof.txt", "first version");
    await expect(policy.createTextFile("test", "proof.txt", "second version")).rejects.toMatchObject({
      code: "TARGET_EXISTS",
    });
    await expect(readFile(path.join(root, "proof.txt"), "utf8")).resolves.toBe("first version");
  });

  test("does not expose delete, overwrite, append, move, or rename methods", () => {
    const methods = Object.getOwnPropertyNames(FileBridgePolicy.prototype).map((name) => name.toLocaleLowerCase());
    for (const forbidden of ["delete", "overwrite", "append", "move", "rename", "remove", "unlink"]) {
      expect(methods.some((name) => name.includes(forbidden))).toBe(false);
    }
  });

  test("refuses to reuse an existing directory", async () => {
    const { root, policy } = await fixture();
    await mkdir(path.join(root, "existing"));
    await expect(policy.createDirectory("test", "existing")).rejects.toMatchObject({ code: "TARGET_EXISTS" });
  });
});

describe("path containment", () => {
  test.each(["../outside.txt", "folder/../../outside.txt", "C:\\Windows\\win.ini", "\\\\server\\share\\file.txt"])(
    "blocks traversal or absolute path: %s",
    async (unsafe) => {
      const { policy } = await fixture();
      await expect(policy.statPath("test", unsafe)).rejects.toBeInstanceOf(PolicyError);
    },
  );

  test.each([
    ".env",
    ".ssh/id_ed25519",
    "AppData/Local/file.txt",
    "project/private.pem",
    "project/putty.ppk",
    "id_ed25519_vps.ppk",
    "backup/id_rsa_work",
    ".git/config",
  ])(
    "blocks a sensitive path: %s",
    async (unsafe) => {
      const { policy } = await fixture();
      await expect(policy.statPath("test", unsafe)).rejects.toMatchObject({ code: "SENSITIVE_PATH_BLOCKED" });
    },
  );

  test("blocks and hides a directory junction or symlink that leaves the root", async () => {
    const { base, root, policy } = await fixture();
    const outside = path.join(base, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.txt"), "outside");
    await symlink(outside, path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
    await expect(policy.readTextFile("test", "escape/secret.txt")).rejects.toMatchObject({ code: "LINK_BLOCKED" });
    const listing = await policy.listDirectory("test", "");
    expect(listing.entries.some((entry) => entry.name === "escape")).toBe(false);
    expect(listing.blocked_entries).toBe(1);
    const search = await policy.searchNames("test", "secret");
    expect(search.matches).toEqual([]);
    expect(search.blocked_entries).toBe(1);
  });

  test.each([
    "notes.txt:secret",
    "CON",
    "aux.txt",
    "folder/com1.log",
    "trailing-dot.",
    "trailing-space ",
  ])("blocks Windows alternate streams and reserved path components: %s", async (unsafe) => {
    const { policy } = await fixture();
    await expect(policy.statPath("test", unsafe)).rejects.toMatchObject({ code: "INVALID_PATH_COMPONENT" });
  });

  test.each([
    "\\\\?\\C:\\Windows\\win.ini",
    "\\\\.\\PhysicalDrive0",
    "\\rooted",
    "/rooted",
    "C:drive-relative.txt",
    "folder/child\\mixed.txt",
    "folder//double.txt",
    "folder/./dot.txt",
  ])("fails closed for an ambiguous Windows path representation: %s", async (unsafe) => {
    const { policy } = await fixture();
    await expect(policy.statPath("test", unsafe)).rejects.toBeInstanceOf(PolicyError);
  });

  test("fails closed for zero, unsafe, or ambiguous file identity", async () => {
    expect(sameFileIdentity({ dev: 1, ino: 0 }, { dev: 1, ino: 0 })).toBe(false);
    expect(sameFileIdentity({ dev: 1, ino: Number.MAX_SAFE_INTEGER + 1 }, { dev: 1, ino: Number.MAX_SAFE_INTEGER + 1 })).toBe(false);
    expect(sameFileIdentity({ dev: 1n, ino: 2n }, { dev: 1n, ino: 2n })).toBe(true);

    const { root, policy } = await fixture();
    await writeFile(path.join(root, "hardlink-source.txt"), "fixture", "utf8");
    await link(path.join(root, "hardlink-source.txt"), path.join(root, "hardlink-peer.txt"));
    await expect(policy.statPath("test", "hardlink-source.txt")).rejects.toMatchObject({
      code: "PATH_IDENTITY_AMBIGUOUS",
    });
  });

  test("does not silently normalize a Unicode spelling variant", async () => {
    const { root, policy } = await fixture();
    const stored = "caf\u00e9.txt";
    const alternate = "cafe\u0301.txt";
    await writeFile(path.join(root, stored), "fixture", "utf8");
    await expect(policy.statPath("test", alternate)).rejects.toBeInstanceOf(PolicyError);
  });

  test("requires an explicit exact opt-in for a complete drive root", async () => {
    const filesystemRoot = path.parse(process.cwd()).root;
    const config: FileBridgeConfig = {
      version: 1,
      roots: [{ id: "drive", label: "Whole drive", path: filesystemRoot, read: true, create: true }],
      limits: {
        maxReadBytes: 4096,
        maxWriteBytes: 4096,
        maxDirectoryEntries: 50,
        maxSearchResults: 20,
        maxSearchEntries: 100,
      },
    };
    await expect(FileBridgePolicy.fromConfig(config)).rejects.toMatchObject({ code: "DRIVE_ROOT_NOT_APPROVED" });
  });
});

describe("bounded and redacted reads", () => {
  test("reads ordinary UTF-8 text and redacts common credential forms", async () => {
    const { root, policy } = await fixture();
    await writeFile(
      path.join(root, "notes.txt"),
      "hello\napi_key=abcdefghijklmnop123456\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz",
    );
    const result = await policy.readTextFile("test", "notes.txt");
    expect(result.text).toContain("hello");
    expect(result.text).not.toContain("abcdefghijklmnop123456");
    expect(result.text).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(result.redactions).toBe(2);
  });

  test("returns only the configured prefix", async () => {
    const { root, policy } = await fixture();
    await writeFile(path.join(root, "large.txt"), "x".repeat(5000));
    const result = await policy.readTextFile("test", "large.txt", 2048);
    expect(result.bytes_returned).toBe(2048);
    expect(result.truncated).toBe(true);
  });

  test("rejects invalid UTF-8 instead of returning binary data", async () => {
    const { root, policy } = await fixture();
    await writeFile(path.join(root, "binary.dat"), Buffer.from([0xff, 0xfe, 0xfd]));
    await expect(policy.readTextFile("test", "binary.dat")).rejects.toMatchObject({ code: "NON_TEXT_FILE" });
  });

  test("filters sensitive names from directory listings and searches", async () => {
    const { root, policy } = await fixture();
    await writeFile(path.join(root, "visible.txt"), "ok");
    await writeFile(path.join(root, ".env"), "secret=value");
    await writeFile(path.join(root, "id_ed25519_vps.ppk"), "fake test key");
    await writeFile(path.join(root, "id_rsa_work"), "fake test key");
    await writeFile(path.join(root, "putty-backup.PPK"), "fake test key");
    await mkdir(path.join(root, ".ssh"));
    const listing = await policy.listDirectory("test", "");
    expect(listing.entries.map((entry) => entry.name)).toEqual(["visible.txt"]);
    expect(listing.blocked_entries).toBe(5);
    const search = await policy.searchNames("test", "env");
    expect(search.matches).toEqual([]);
    const keySearch = await policy.searchNames("test", "ppk");
    expect(keySearch.matches).toEqual([]);
    expect(keySearch.blocked_entries).toBe(5);
  });
});
