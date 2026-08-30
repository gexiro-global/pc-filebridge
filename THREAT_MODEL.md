# Threat model

## Assets

- files and directory metadata inside configured roots;
- newly created files and directories;
- local root configuration;
- Secure MCP Tunnel identifiers and runtime API keys;
- host account identity and filesystem permissions.

## Principal threats and controls

| Severity | Threat | Primary controls | Residual risk |
|---|---|---|---|
| Critical | overwrite or deletion of existing data | no mutation tools; exclusive file create; existing directory refusal; invariant tests | host or dependency compromise |
| Critical | credential disclosure | blocked names/extensions/segments; bounded UTF-8 reads; secret redaction; credentials outside Git | unknown secret formats in ordinary files |
| High | path escape | relative paths; canonical containment; link/junction checks; blocked ADS and reserved names | same-user path races |
| High | Windows alternate-name policy bypass | stored-name lookup by exact BigInt file identity; alternate spelling rejection; stored-name denylist; real 8.3 integration test | filesystem races or a more-privileged local process |
| High | hard-link aliasing | ambiguous identity rejection and multiply linked regular-file refusal | privileged filesystem mutation after validation |
| High | unauthorized remote access | local stdio; authenticated private tunnel; dedicated revocable runtime key | compromised client account or host |
| High | split-brain or tunnel-role confusion | distinct PC, laptop, and infrastructure tunnel identities; exact metadata-name, root-ID, and root-path validation; one poller per tunnel; local operator gates locked by default | control-plane or host compromise |
| High | secret leakage from deployment artifacts | external read-only secret mount; no values in Git, image layers, Compose, arguments, or logs | root compromise or unencrypted host storage |
| High | prompt injection from files | content labeled and documented as untrusted; no server-side instruction following | client model may misinterpret data |
| High | excessive disclosure | explicit roots; full-drive fail-closed opt-in; size/result/traversal bounds | operator configures roots too broadly |
| High | unsafe automatic volume exposure | fixed-disk inventory plus allowlisted bus and NTFS/ReFS policy; healthy-state and stable disk/partition/volume identity required; exact role-prefix/drive-letter binding; required system volume; private generated config; USB, removable, optical, network, unknown, and unhealthy volumes excluded | an allowed fixed disk may still contain sensitive ordinary documents |
| Medium | resource exhaustion | byte, entry, result, and traversal limits | slow or hostile filesystems |
| Medium | sensitive logs | categorical error codes only; no content or absolute paths on stderr | operator-added logging |
| Medium | partial create after hardware failure | exclusive create and sync; explicit `WRITE_INCOMPLETE`; no automatic cleanup | manual cleanup may be required |
| Medium | VPS availability or storage loss | restart policy; readiness probe; persistent data volume; verified recovery artifacts | provider or host failure |

All MCP arguments, filenames, file contents, configuration values, filesystem metadata, and client responses are untrusted input. PC FileBridge is not a sandbox for arbitrary code and must not be run with broader operating-system privileges than required.
