import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contract = JSON.parse(await readFile(path.join(root, "config", "tunnel-roles.json"), "utf8"));
const autostartInstallers = await Promise.all(
  ["Install-PCFileBridgeAutostart.ps1", "Install-PCFileBridgeRoleAutostart.ps1"].map((name) =>
    readFile(path.join(root, "scripts", name), "utf8"),
  ),
);
const roleTask = await readFile(
  path.join(root, "scripts", "Connect-PCFileBridgeRoleTunnel-Task.ps1"),
  "utf8",
);
const volumeMonitor = await readFile(
  path.join(root, "scripts", "Start-PCFileBridgeVolumeMonitor.ps1"),
  "utf8",
);
for (const roleEntryPoint of [autostartInstallers[1], roleTask, volumeMonitor]) {
  if (!roleEntryPoint.includes("$Role = $Role.ToLowerInvariant()")) {
    throw new Error("Role entry points must normalize case before case-sensitive contract checks.");
  }
}
for (const windowsPowerShellScript of [...autostartInstallers, roleTask]) {
  if (windowsPowerShellScript.includes("IsPathFullyQualified")) {
    throw new Error("Windows PowerShell 5.1 scripts must not call IsPathFullyQualified.");
  }
}
const requiredAutostartSettings = [
  "-Compatibility Win8",
  "-AllowStartIfOnBatteries",
  "-DontStopIfGoingOnBatteries",
  "-StartWhenAvailable",
  "-DontStopOnIdleEnd",
  "-ExecutionTimeLimit ([TimeSpan]::Zero)",
  "-MultipleInstances IgnoreNew",
  "-RestartCount 5",
  "-RestartInterval (New-TimeSpan -Minutes 1)",
];
for (const autostartInstaller of autostartInstallers) {
  for (const setting of requiredAutostartSettings) {
    if (!autostartInstaller.includes(setting)) {
      throw new Error(`Autostart installer is missing durable setting: ${setting}`);
    }
  }
  if (/ExecutionTimeLimit\s+\(New-TimeSpan/i.test(autostartInstaller)) {
    throw new Error("Autostart installer must not impose a finite execution time limit.");
  }
}
const volumePolicy = (rootIdPrefix) => ({
  enabled: true,
  driveType: 3,
  rootIdPrefix,
  allowedBusTypes: ["NVMe", "SATA", "SAS", "RAID", "Storage Spaces", "SCM"],
  allowedFileSystems: ["NTFS"],
  requireHealthy: true,
});
const expectedRoles = new Map([
  ["pc-local", {
    configName: "roots.pc.example.json",
    hostId: "pc-main",
    tunnelName: "PC FileBridge - PC Local",
    alias: "pc-filebridge-pc-local",
    gateRequired: true,
    rootIds: ["pc-c", "pc-d"],
    requiredRootIds: ["pc-c"],
    rootPaths: { "pc-c": "C:\\", "pc-d": "D:\\" },
    volumeDiscovery: volumePolicy("pc-"),
  }],
  ["laptop-local", {
    configName: "roots.laptop.example.json",
    hostId: "laptop-main",
    tunnelName: "PC FileBridge - Laptop Local",
    alias: "pc-filebridge-laptop-local",
    gateRequired: true,
    rootIds: ["laptop-c", "laptop-d"],
    requiredRootIds: ["laptop-c"],
    rootPaths: { "laptop-c": "C:\\", "laptop-d": "D:\\" },
    volumeDiscovery: volumePolicy("laptop-"),
  }],
  ["infrastructure", {
    configName: "roots.infrastructure.example.json",
    tunnelName: "PC FileBridge - Infrastructure",
    alias: "pc-filebridge-infrastructure",
    gateRequired: false,
    rootIds: ["primary-data", "secondary-data", "agent-data"],
    requiredRootIds: ["primary-data", "secondary-data"],
    rootPaths: { "primary-data": "/data/primary", "secondary-data": "/data/secondary", "agent-data": "/data/agent" },
  }],
]);

if (contract.version !== 1 || !Array.isArray(contract.roles)) {
  throw new Error("Tunnel role contract must use version 1 and contain a roles array.");
}
if (contract.roles.length !== expectedRoles.size) {
  throw new Error("Tunnel role contract must define exactly three roles.");
}

const names = new Set();
const aliases = new Set();
const allRootIds = new Set();
for (const role of contract.roles) {
  const expected = expectedRoles.get(role.id);
  if (!expected) throw new Error(`Unexpected tunnel role: ${role.id}`);
  const configName = expected.configName;
  if (expected.hostId !== undefined && role.hostId !== expected.hostId) {
    throw new Error(`Unexpected host id for role ${role.id}`);
  }
  if (role.expectedTunnelName !== expected.tunnelName) {
    throw new Error(`Unexpected tunnel name for role ${role.id}`);
  }
  if (role.alias !== expected.alias) throw new Error(`Unexpected runtime alias for role ${role.id}`);
  if (role.gateRequired !== expected.gateRequired) throw new Error(`Invalid gate policy for role ${role.id}`);
  if (JSON.stringify(role.rootIds) !== JSON.stringify(expected.rootIds)) {
    throw new Error(`Invalid allowed roots for role ${role.id}`);
  }
  if (JSON.stringify(role.requiredRootIds) !== JSON.stringify(expected.requiredRootIds)) {
    throw new Error(`Invalid required roots for role ${role.id}`);
  }
  if (JSON.stringify(role.rootPaths) !== JSON.stringify(expected.rootPaths)) {
    throw new Error(`Invalid root paths for role ${role.id}`);
  }
  if (JSON.stringify(role.volumeDiscovery) !== JSON.stringify(expected.volumeDiscovery)) {
    throw new Error(`Invalid volume discovery policy for role ${role.id}`);
  }
  if (names.has(role.expectedTunnelName)) throw new Error("Tunnel names must be unique.");
  if (aliases.has(role.alias)) throw new Error("Runtime aliases must be unique.");
  names.add(role.expectedTunnelName);
  aliases.add(role.alias);

  if (!Array.isArray(role.rootIds) || role.rootIds.length < 1) {
    throw new Error(`Role ${role.id} must declare root ids.`);
  }
  if (!Array.isArray(role.requiredRootIds) || role.requiredRootIds.length < 1) {
    throw new Error(`Role ${role.id} must declare required root ids.`);
  }
  if (new Set(role.rootIds).size !== role.rootIds.length) throw new Error(`Duplicate root id in role ${role.id}`);
  for (const requiredId of role.requiredRootIds) {
    if (!role.rootIds.includes(requiredId)) throw new Error(`Required root is not allowed for role ${role.id}`);
  }

  const config = JSON.parse(await readFile(path.join(root, "config", configName), "utf8"));
  const configuredIds = config.roots.map((entry) => entry.id);
  for (const entry of config.roots) {
    if (entry.path !== expected.rootPaths[entry.id]) {
      throw new Error(`Root path for ${entry.id} does not match role ${role.id}.`);
    }
  }
  const configuredUnique = new Set(configuredIds);
  if (configuredUnique.size !== configuredIds.length) {
    throw new Error(`Duplicate root id in ${configName}.`);
  }
  if (configuredIds.some((rootId) => !role.rootIds.includes(rootId))) {
    throw new Error(`Root ids for role ${role.id} exceed the role contract.`);
  }
  if (role.requiredRootIds.some((rootId) => !configuredUnique.has(rootId))) {
    throw new Error(`Required root ids for role ${role.id} are absent from ${configName}.`);
  }
  const configuredInContractOrder = role.rootIds.filter((rootId) => configuredUnique.has(rootId));
  if (JSON.stringify(configuredIds) !== JSON.stringify(configuredInContractOrder)) {
    throw new Error(`Root ids for role ${role.id} are not in contract order.`);
  }
  for (const rootId of role.rootIds) {
    if (allRootIds.has(rootId)) throw new Error(`Root id is reused across roles: ${rootId}`);
    allRootIds.add(rootId);
  }
}

process.stdout.write(
  `TUNNEL_ROLE_CONTRACT_PASS roles=${contract.roles.length} tunnel_names=${names.size} root_ids=${allRootIds.size}\n`,
);
