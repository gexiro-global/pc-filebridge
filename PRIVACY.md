# Privacy

Last updated: 2026-08-26

PC FileBridge is self-hosted software. The maintainers do not operate a shared FileBridge service and the software includes no analytics or telemetry.

The deployment operator selects filesystem roots and controls the host, MCP client, tunnel, retention, access policy, and backups. A tool call can send requested filenames, metadata, or bounded text content to the connected MCP client and its model provider. Those systems have their own privacy and retention policies.

The server itself stores no index, database, prompt history, or copy of read content. It creates files only when the client invokes a create tool. Tunnel credentials and local root configuration must remain outside version control.

The maintainers receive no deployment data unless an operator deliberately includes it in a support or security report. Reports must be minimized and redacted.

Disconnect the MCP client and revoke the dedicated tunnel runtime key to terminate remote access. Remove or narrow local roots to reduce future access. Files already sent to a connected client follow that client's separate retention controls.
