# VPS deployment with Secure MCP Tunnel

This deployment keeps PC FileBridge online independently of a laptop or desktop by storing the exposed files in a persistent VPS volume. It does not mirror or remotely read a powered-off PC disk. Files that must be available on every device must first exist in the server data volume.

## Trust boundaries

- `pc-filebridge-data` contains only operator-selected server files.
- `pc-filebridge-secrets` contains the dedicated runtime key and tunnel ID and is mounted read-only.
- Secrets never belong in the image, Compose file, Git history, command line, or logs.
- The service runs as UID/GID 10001, with a read-only root filesystem, no Linux capabilities, no published ports, bounded resources, warning-only rotated logs, and a tunnel-aware healthcheck.
- Secure MCP Tunnel makes an outbound authenticated connection. Do not publish a second unauthenticated MCP endpoint.

## Prerequisites

- Docker Engine with Compose v2.
- A dedicated OpenAI runtime key with Tunnel Read and Use permissions.
- A Secure MCP Tunnel named exactly `PC FileBridge - Infrastructure`.
- Two pre-created external volumes named `pc-filebridge-data` and `pc-filebridge-secrets`.

Place the two single-line secret files in the secret volume as `OPENAI_API_KEY` and `TUNNEL_ID`, mode `0600`, owned by UID/GID 10001. Transfer them through an authenticated encrypted channel and remove temporary plaintext immediately. Do not use an OpenAI admin key for the runtime.

Create `/data/primary` and `/data/secondary` in the data volume and make them writable by UID/GID 10001. The supplied root configuration exposes only the neutral `primary-data` and `secondary-data` examples and preserves the create-only policy. To enable an optional remote agent, create or mount `/data/agent`, add the documented `agent-data` entry to a private runtime configuration derived from the example, and point `FILEBRIDGE_CONFIG` at that mounted read-only file. Never advertise `agent-data` when its authorized storage is absent.

Only this infrastructure host may run the tunnel-client poller for the infrastructure tunnel. Secondary hosts and remote agents must connect through authorized mounts or agents; they must never run a second poller with the same tunnel identifier.

## Build and preflight

From the repository root:

```sh
npm ci --ignore-scripts
npm run verify
docker compose -f deploy/docker/compose.example.yml build --pull
npm run check:container
docker compose -f deploy/docker/compose.example.yml config --quiet
```

The image pins both the Node base image and the official Secure MCP Tunnel image by immutable OCI digest.

### Optional host-managed CA

If the Linux host requires a host-managed CA bundle for outbound TLS inspection, validate and start with the supplied overlay:

```sh
docker compose \
  -f deploy/docker/compose.example.yml \
  -f deploy/docker/compose.host-ca.example.yml \
  config --quiet
```

The overlay mounts the host CA bundle read-only and points Node.js at it. Use it only when required by the host trust policy. Never disable certificate verification or add insecure tunnel flags.

## Start and verify

```sh
docker compose -f deploy/docker/compose.example.yml up -d
docker inspect --format '{{.State.Health.Status}}' pc-filebridge
docker logs --tail 100 pc-filebridge
```

Report success only when the container is running, the healthcheck reports a recent successful command poll, the tunnel is connected, and a client can list exactly seven tools with no forbidden mutation tools. Then test one new-file create and verify that a second create at the same path returns `TARGET_EXISTS` without changing the original bytes.

## Recovery

Keep release checksums, the exact Git commit, the image digest, and an encrypted backup of the two volumes. A rollback should start the prior verified image against the same volumes; never copy secrets into a repository or image layer. Rotate the runtime key after suspected exposure.

## Public distribution boundary

This Compose deployment is a self-hosted private connector. A public ChatGPT app submission is a separate product surface and requires a stable public HTTPS Streamable HTTP MCP endpoint plus the applicable authentication and review requirements. Secure MCP Tunnel alone is not a public marketplace endpoint.
