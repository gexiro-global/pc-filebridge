import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { FileBridgePolicy, PolicyError } from "./filePolicy.js";

const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const createAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const rootId = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
const relativePath = z.string().max(4096).default("");

async function main(): Promise<void> {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const pluginRoot = path.resolve(moduleDirectory, "..");
  const configPath = path.resolve(process.env.FILEBRIDGE_CONFIG ?? path.join(pluginRoot, "config", "roots.local.json"));
  const policy = await FileBridgePolicy.fromFile(configPath);
  const server = new McpServer(
    { name: "pc-filebridge", version: "0.2.2" },
    {
      instructions:
        "Create-only filesystem bridge. Use only configured root IDs and relative paths. " +
        "Reads are bounded and secret-redacted. Writes may create a new file or directory only. " +
        "Overwrite, append, patch, rename, move, link traversal, and delete are unavailable and must never be claimed.",
    },
  );

  server.registerTool(
    "list_roots",
    {
      title: "List allowed PC folders",
      description: "List the configured filesystem roots and whether each permits bounded reads and create-only writes.",
      inputSchema: z.object({}),
      annotations: readAnnotations,
    },
    async () => execute(() => ({ roots: policy.listRoots() })),
  );

  server.registerTool(
    "list_directory",
    {
      title: "List a directory",
      description:
        "List entries inside an allowed root using a relative path. Sensitive names and links are omitted server-side.",
      inputSchema: z.object({
        root_id: rootId,
        relative_path: relativePath,
        limit: z.number().int().min(1).max(1000).optional(),
      }),
      annotations: readAnnotations,
    },
    async ({ root_id, relative_path, limit }) => execute(() => policy.listDirectory(root_id, relative_path, limit)),
  );

  server.registerTool(
    "stat_path",
    {
      title: "Inspect file or directory metadata",
      description: "Read bounded metadata for one existing relative path without opening file content.",
      inputSchema: z.object({ root_id: rootId, relative_path: relativePath }),
      annotations: readAnnotations,
    },
    async ({ root_id, relative_path }) => execute(() => policy.statPath(root_id, relative_path)),
  );

  server.registerTool(
    "read_text_file",
    {
      title: "Read a UTF-8 text file",
      description:
        "Read a bounded UTF-8 prefix from one allowed file. Known credential patterns are redacted and binary files are rejected.",
      inputSchema: z.object({
        root_id: rootId,
        relative_path: z.string().min(1).max(4096),
        max_bytes: z.number().int().min(1024).max(1024 * 1024).optional(),
      }),
      annotations: readAnnotations,
    },
    async ({ root_id, relative_path, max_bytes }) => execute(() => policy.readTextFile(root_id, relative_path, max_bytes)),
  );

  server.registerTool(
    "search_file_names",
    {
      title: "Search file and directory names",
      description:
        "Recursively search names, not file contents, below an allowed relative path. Results and traversal are strictly bounded.",
      inputSchema: z.object({
        root_id: rootId,
        query: z.string().min(1).max(200),
        start_path: relativePath,
      }),
      annotations: readAnnotations,
    },
    async ({ root_id, query, start_path }) => execute(() => policy.searchNames(root_id, query, start_path)),
  );

  server.registerTool(
    "create_directory",
    {
      title: "Create a new directory",
      description:
        "Create exactly one new directory below an allowed root. The parent must exist. Existing paths are never replaced or reused.",
      inputSchema: z.object({ root_id: rootId, relative_path: z.string().min(1).max(4096) }),
      annotations: createAnnotations,
    },
    async ({ root_id, relative_path }) => execute(() => policy.createDirectory(root_id, relative_path)),
  );

  server.registerTool(
    "create_text_file",
    {
      title: "Create a new text file",
      description:
        "Create one new UTF-8 text file using OS-level exclusive create mode. If the target exists, the call fails without changing it.",
      inputSchema: z.object({
        root_id: rootId,
        relative_path: z.string().min(1).max(4096),
        content: z.string().max(1024 * 1024),
      }),
      annotations: createAnnotations,
    },
    async ({ root_id, relative_path, content }) => execute(() => policy.createTextFile(root_id, relative_path, content)),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const close = () => {
    void server.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

async function execute(operation: () => Promise<object> | object) {
  try {
    const data = await operation();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data) }],
      structuredContent: data as Record<string, unknown>,
    };
  } catch (error) {
    const safe = safeError(error);
    process.stderr.write(`${JSON.stringify({ event: "tool_error", code: safe.code })}\n`);
    return {
      isError: true,
      content: [{ type: "text" as const, text: JSON.stringify({ error: safe }) }],
    };
  }
}

function safeError(error: unknown): { code: string; message: string } {
  if (error instanceof PolicyError) return { code: error.code, message: error.message };
  if (error instanceof z.ZodError) return { code: "INVALID_INPUT", message: "Tool input did not match the required schema." };
  return { code: "INTERNAL_ERROR", message: "The filesystem operation failed safely." };
}

main().catch((error: unknown) => {
  const safe = safeError(error);
  process.stderr.write(`${JSON.stringify({ event: "startup_failed", code: safe.code, message: safe.message })}\n`);
  process.exitCode = 1;
});
