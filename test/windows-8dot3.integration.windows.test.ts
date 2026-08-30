import { execFileSync } from "node:child_process";
import { link, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { FileBridgePolicy, type FileBridgeConfig } from "../src/filePolicy.js";

if (process.platform !== "win32") {
  throw new Error("The mandatory Windows 8.3 integration test must run on Windows.");
}

describe("real Windows 8.3 alternate-name policy", () => {
  let base: string;
  let root: string;
  let longBlocked: string;
  let shortBlocked: string;
  let longOrdinary: string;
  let shortOrdinary: string;
  let nestedOrdinary: string;
  let policy: FileBridgePolicy;

  beforeAll(async () => {
    base = await mkdtemp(path.join(process.cwd(), ".pc-filebridge-8dot3-"));
    root = path.join(base, "allowed");
    longBlocked = path.join(root, "Program Files");
    shortBlocked = path.join(root, "PROGRA~1");
    longOrdinary = path.join(root, "Ordinary Long Folder");
    shortOrdinary = path.join(root, "ORDINA~1");
    nestedOrdinary = path.join(longOrdinary, "Nested Long Folder");
    await mkdir(path.join(longBlocked, "Common Files"), { recursive: true });
    await mkdir(nestedOrdinary, { recursive: true });
    await writeFile(path.join(longBlocked, "fixture.txt"), "safe integration fixture", "utf8");

    execFileSync("fsutil.exe", ["file", "setshortname", longBlocked, "PROGRA~1"], { stdio: "pipe" });
    execFileSync("fsutil.exe", ["file", "setshortname", longOrdinary, "ORDINA~1"], { stdio: "pipe" });
    execFileSync("fsutil.exe", ["file", "setshortname", nestedOrdinary, "NESTED~1"], { stdio: "pipe" });
    execFileSync("fsutil.exe", ["file", "setshortname", path.join(longBlocked, "Common Files"), "COMMON~1"], {
      stdio: "pipe",
    });

    const [longInfo, shortInfo, nestedShortInfo] = await Promise.all([
      lstat(longBlocked),
      lstat(shortBlocked),
      lstat(path.join(shortBlocked, "COMMON~1")),
    ]);
    if (longInfo.ino === 0 || shortInfo.ino === 0 || nestedShortInfo.ino === 0) {
      throw new Error("Windows fixture file identity is unavailable or zero.");
    }
    if (longInfo.dev !== shortInfo.dev || longInfo.ino !== shortInfo.ino) {
      throw new Error("PROGRA~1 does not identify the controlled long-name fixture.");
    }

    const config: FileBridgeConfig = {
      version: 1,
      roots: [{ id: "test", label: "Windows 8.3 fixture", path: root, read: true, create: true }],
      limits: {
        maxReadBytes: 4096,
        maxWriteBytes: 4096,
        maxDirectoryEntries: 50,
        maxSearchResults: 20,
        maxSearchEntries: 100,
      },
    };
    policy = await FileBridgePolicy.fromConfig(config);
  });

  afterAll(async () => {
    if (base) await rm(base, { recursive: true, force: true });
  });

  test("confirms the real short-name fixture", async () => {
    const [longInfo, shortInfo] = await Promise.all([lstat(longBlocked), lstat(shortBlocked)]);
    expect(shortInfo.ino).not.toBe(0);
    expect({ dev: shortInfo.dev, ino: shortInfo.ino }).toEqual({ dev: longInfo.dev, ino: longInfo.ino });
  });

  test("blocks the sensitive long name", async () => {
    await expect(policy.statPath("test", "Program Files")).rejects.toMatchObject({ code: "SENSITIVE_PATH_BLOCKED" });
  });

  test("blocks a real alternate name even when the stored long name is ordinary", async () => {
    const [longInfo, shortInfo] = await Promise.all([lstat(longOrdinary), lstat(shortOrdinary)]);
    expect({ dev: shortInfo.dev, ino: shortInfo.ino }).toEqual({ dev: longInfo.dev, ino: longInfo.ino });
    await expect(policy.statPath("test", "ORDINA~1")).rejects.toMatchObject({ code: "ALTERNATE_NAME_BLOCKED" });
  });

  test("blocks a nested alternate component below an exactly spelled parent", async () => {
    await expect(policy.statPath("test", "Ordinary Long Folder/NESTED~1")).rejects.toMatchObject({
      code: "ALTERNATE_NAME_BLOCKED",
    });
  });

  test("rejects a configured root that itself uses an alternate name", async () => {
    const config: FileBridgeConfig = {
      version: 1,
      roots: [{ id: "alias", label: "Alias root", path: shortOrdinary, read: true, create: true }],
      limits: {
        maxReadBytes: 4096,
        maxWriteBytes: 4096,
        maxDirectoryEntries: 50,
        maxSearchResults: 20,
        maxSearchEntries: 100,
      },
    };
    await expect(FileBridgePolicy.fromConfig(config)).rejects.toMatchObject({ code: "ALTERNATE_NAME_BLOCKED" });
  });

  test("allows an alternate ancestor outside an exactly spelled configured root", async () => {
    const longParent = path.join(base, "Configured Root Parent");
    const shortParent = path.join(base, "CONFIG~1");
    const exactRoot = path.join(longParent, "Allowed Root");
    await mkdir(exactRoot, { recursive: true });
    execFileSync("fsutil.exe", ["file", "setshortname", longParent, "CONFIG~1"], { stdio: "pipe" });

    const [longInfo, shortInfo] = await Promise.all([lstat(longParent), lstat(shortParent)]);
    expect({ dev: shortInfo.dev, ino: shortInfo.ino }).toEqual({ dev: longInfo.dev, ino: longInfo.ino });

    const config: FileBridgeConfig = {
      version: 1,
      roots: [{ id: "trusted-ancestor", label: "Trusted ancestor", path: path.join(shortParent, "Allowed Root"), read: true, create: true }],
      limits: {
        maxReadBytes: 4096,
        maxWriteBytes: 4096,
        maxDirectoryEntries: 50,
        maxSearchResults: 20,
        maxSearchEntries: 100,
      },
    };
    await expect(FileBridgePolicy.fromConfig(config)).resolves.toBeInstanceOf(FileBridgePolicy);
  });

  test.each([
    ["stat", () => policy.statPath("test", "PROGRA~1")],
    ["nested stat", () => policy.statPath("test", "PROGRA~1/COMMON~1")],
    ["list", () => policy.listDirectory("test", "PROGRA~1")],
    ["read", () => policy.readTextFile("test", "PROGRA~1/fixture.txt")],
    ["search", () => policy.searchNames("test", "fixture", "PROGRA~1")],
    ["create directory", () => policy.createDirectory("test", "PROGRA~1/new-directory")],
    ["create text file", () => policy.createTextFile("test", "PROGRA~1/new-file.txt", "must not be created")],
  ])("blocks %s through a real alternate name", async (_label, operation) => {
    await expect(operation()).rejects.toMatchObject({
      code: expect.stringMatching(/^(ALTERNATE_NAME_BLOCKED|SENSITIVE_PATH_BLOCKED)$/),
    });
  });

  test("allows case-only spelling and a literal legal tilde name", async () => {
    await mkdir(path.join(root, "Case Folder"));
    await mkdir(path.join(root, "legal~1-name"));
    await expect(policy.statPath("test", "case folder")).resolves.toMatchObject({ kind: "directory" });
    await expect(policy.statPath("test", "legal~1-name")).resolves.toMatchObject({ kind: "directory" });
  });

  test("keeps create-only behavior inside the ordinary root", async () => {
    await policy.createTextFile("test", "proof.txt", "first");
    await expect(policy.createTextFile("test", "proof.txt", "second")).rejects.toMatchObject({ code: "TARGET_EXISTS" });
    await expect(readFile(path.join(root, "proof.txt"), "utf8")).resolves.toBe("first");
  });

  test("fails closed for hard-linked file identities", async () => {
    await writeFile(path.join(root, "hardlink-source.txt"), "fixture", "utf8");
    await link(path.join(root, "hardlink-source.txt"), path.join(root, "hardlink-peer.txt"));
    await expect(policy.statPath("test", "hardlink-source.txt")).rejects.toMatchObject({
      code: expect.stringMatching(/^(HARDLINK_BLOCKED|PATH_IDENTITY_AMBIGUOUS)$/),
    });
  });
});
