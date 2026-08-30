import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const expectedTools = [
  "create_directory",
  "create_text_file",
  "list_directory",
  "list_roots",
  "read_text_file",
  "search_file_names",
  "stat_path",
];

const client = new Client({ name: "pc-filebridge-smoke", version: "0.2.2" });
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDirectory = await mkdtemp(path.join(pluginRoot, ".pc-filebridge-mcp-smoke-"));
const configPath = path.join(fixtureDirectory, "roots.json");
await writeFile(configPath, JSON.stringify({
  version: 1,
  roots: [{ id: "smoke", label: "Smoke test", path: fixtureDirectory, read: true, create: true }],
  limits: {
    maxReadBytes: 4096,
    maxWriteBytes: 4096,
    maxDirectoryEntries: 50,
    maxSearchResults: 20,
    maxSearchEntries: 100,
  },
}), "utf8");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(pluginRoot, "mcp", "server.mjs")],
  cwd: pluginRoot,
  env: { FILEBRIDGE_CONFIG: configPath },
});

try {
  await client.connect(transport);
  const catalog = await client.listTools();
  const actualTools = catalog.tools.map((tool) => tool.name).sort();
  if (JSON.stringify(actualTools) !== JSON.stringify(expectedTools)) {
    throw new Error(`Unexpected MCP tool catalog: ${JSON.stringify(actualTools)}`);
  }
  if (actualTools.some((name) => /delete|overwrite|append|rename|move|remove|unlink/i.test(name))) {
    throw new Error("A forbidden mutation tool was exposed.");
  }
  const roots = await client.callTool({ name: "list_roots", arguments: {} });
  if (roots.isError) throw new Error("list_roots returned an MCP error.");
  process.stdout.write("MCP_SMOKE_PASS tools=7 forbidden_mutations=0 list_roots=ok\n");
} finally {
  await client.close();
  await rm(fixtureDirectory, { recursive: true, force: true });
}
