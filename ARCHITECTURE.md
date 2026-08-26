# Architecture

PC FileBridge is a local stdio MCP server. The MCP client launches `mcp/server.mjs`; the server loads one operator-controlled JSON configuration and exposes seven bounded tools.

## Components

- `.mcp.json` and `.codex-plugin/plugin.json` describe the Codex integration.
- `src/server.ts` defines the fixed MCP tool catalog and translates policy failures into structured MCP errors.
- `src/filePolicy.ts` owns root authorization, path validation, link containment, read bounds, redaction, and exclusive-create writes.
- `config/roots.local.json` is operator data, is ignored by Git, and fails closed when absent.
- Secure MCP Tunnel helper scripts connect a dedicated runtime on the PC to ChatGPT. Secrets remain outside the repository under the current user's local application-data directory.

## Data flow

1. The client requests one named tool with a configured `root_id` and relative path.
2. The server validates the schema and delegates to the file policy.
3. The policy resolves and canonicalizes the path, rejects sensitive components and link escapes, enforces the operation-specific bounds, and performs the filesystem operation.
4. The server returns bounded metadata or redacted UTF-8 text. Absolute host paths are not returned.

The server initiates no network connection and executes no shell command. Remote access is a separate authenticated transport boundary; it does not change the filesystem policy.

## Security invariants

- Reads never imply writes.
- Writes create one previously absent file or directory and never mutate an existing path.
- The tool catalog has no delete, overwrite, append, move, rename, patch, or link operation.
- Link and reparse-point traversal is rejected before access; read handles are checked again after opening.
- Full-drive roots require both configuration and an exact process-level opt-in.

Residual risks and operator controls are documented in [THREAT_MODEL.md](THREAT_MODEL.md) and [SECURITY.md](SECURITY.md).
