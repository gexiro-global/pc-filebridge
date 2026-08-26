# Security policy

## Supported versions

Security fixes target the latest release and the current `main` branch. Older versions may not receive backports.

## Reporting

Use [GitHub private vulnerability reporting](https://github.com/gexiro-global/pc-filebridge/security/advisories/new). Do not open a public issue containing credentials, private keys, private filenames, document content, absolute host paths, production tunnel identifiers, or unredacted logs.

## Enforced invariants

- Every operation is scoped to a configured root ID and relative path.
- Absolute, UNC, traversal, alternate-data-stream, reserved-name, symlink, junction, and reparse-point paths are rejected.
- Canonicalized targets must remain inside their root.
- File creation uses `open(..., "wx")`; directory creation is non-recursive and refuses existing targets.
- The tool catalog contains no overwrite, append, patch, rename, move, link, delete, remove, or unlink capability.
- Reads, listings, searches, and writes have server-side bounds.
- Reads accept UTF-8 only and redact common credential patterns.
- Sensitive system and credential names, including `.ppk`, Java keystores, and SSH private-key variants, are hidden from listings/search and blocked directly.
- A complete filesystem root requires the exact `FILEBRIDGE_ALLOW_DRIVE_ROOT=I_ACCEPT_FULL_DRIVE_ACCESS_RISK` opt-in.
- The server executes no shell commands and initiates no network connections.

## Trust boundary

Files and filenames are untrusted input and may contain prompt injection. MCP clients must treat returned content as data, never as instructions. The stdio process relies on the operating-system identity that launches it. A remote connection must use an authenticated private transport such as OpenAI Secure MCP Tunnel.

## Residual risk

- An allowed folder may still contain ordinary private documents not recognized by filename filters.
- Pattern redaction cannot detect every custom secret format.
- A malicious same-user local process may attempt path races. Pre/post-open checks reduce risk, but portable Node.js does not provide Windows `openat2` semantics.
- Full-drive mode expands exposure even while deny rules remain active.
- A failed physical write may leave a partial new file. The server intentionally does not delete it.
- Data returned to an MCP client follows that client's model-provider and workspace policies.

## Operator responsibilities

Use narrow roots, run the process as a non-administrator, protect tunnel credentials, keep configuration and credential files out of Git, review client tool permissions, patch dependencies, and revoke the tunnel key after suspected exposure.

Security controls reduce known risk; they are not a guarantee that every deployment is safe.
