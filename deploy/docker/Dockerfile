# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e
ARG GO_IMAGE=golang:1.27.0-bookworm@sha256:ded31c68586d2e49e760acc2e65a884b23d032e9bbbed0ae0c55abd3fcaf4452
ARG TUNNEL_ASSETS_IMAGE=ghcr.io/openai/tunnel-client:v0.0.13@sha256:4c6b1441a6ca2506ce04231c1022e6ada32ec488f41d300a4f29f7675cfb4337
ARG TUNNEL_COMMIT=4b5267f823be0b046bb883aacb51603cfde3a0ea
ARG OTEL_VERSION=v1.44.0
ARG X_NET_VERSION=v0.56.0
ARG APP_VERSION=0.2.1

FROM ${NODE_IMAGE} AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM ${GO_IMAGE} AS tunnel-builder
ARG TARGETOS=linux
ARG TARGETARCH=amd64
ARG TUNNEL_COMMIT
ARG OTEL_VERSION
ARG X_NET_VERSION
WORKDIR /src
RUN git init . \
    && git remote add origin https://github.com/openai/tunnel-client.git \
    && git fetch --depth 1 origin "${TUNNEL_COMMIT}" \
    && git checkout --detach FETCH_HEAD \
    && test "$(git rev-parse HEAD)" = "${TUNNEL_COMMIT}"
RUN go get \
      "go.opentelemetry.io/otel@${OTEL_VERSION}" \
      "go.opentelemetry.io/otel/metric@${OTEL_VERSION}" \
      "go.opentelemetry.io/otel/sdk@${OTEL_VERSION}" \
      "go.opentelemetry.io/otel/sdk/metric@${OTEL_VERSION}" \
      "go.opentelemetry.io/otel/trace@${OTEL_VERSION}" \
      "golang.org/x/net@${X_NET_VERSION}" \
    && go mod tidy \
    && go mod verify \
    && go test ./... \
    && CGO_ENABLED=0 GOOS="${TARGETOS}" GOARCH="${TARGETARCH}" go build \
      -trimpath \
      -ldflags "-s -w -X github.com/openai/tunnel-client/pkg/version.GitSHA=${TUNNEL_COMMIT}" \
      -o /out/tunnel-client \
      ./cmd/client \
    && go clean -cache -modcache

FROM ${TUNNEL_ASSETS_IMAGE} AS tunnel-assets

FROM ${NODE_IMAGE} AS runtime
ARG APP_VERSION
LABEL org.opencontainers.image.title="PC FileBridge" \
      org.opencontainers.image.description="Create-only filesystem MCP runtime" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.licenses="Apache-2.0"

ENV NODE_ENV=production \
    HOME=/tmp \
    PC_FILEBRIDGE_VERSION="${APP_VERSION}" \
    FILEBRIDGE_ROLE=infrastructure \
    EXPECTED_TUNNEL_NAME="PC FileBridge - Infrastructure" \
    FILEBRIDGE_CONFIG=/app/config/roots.infrastructure.json \
    HEALTH_LISTEN_ADDR=127.0.0.1:8080 \
    LOG_FORMAT=json \
    LOG_LEVEL=warn \
    TUNNEL_HEALTH_MAX_AGE_SECONDS=180

RUN groupadd --gid 10001 filebridge \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin filebridge \
    && install -d -o 10001 -g 10001 /app/config /data/primary /data/secondary /usr/share/pc-filebridge/tunnel-client

RUN rm -rf /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx

WORKDIR /app
COPY --from=build --chown=10001:10001 /src/mcp/server.mjs /app/mcp/server.mjs
COPY --chown=10001:10001 config/roots.infrastructure.example.json /app/config/roots.infrastructure.json
COPY deploy/docker/entrypoint.sh /usr/local/bin/pc-filebridge-entrypoint
COPY deploy/docker/healthcheck.mjs /usr/local/lib/pc-filebridge/healthcheck.mjs
COPY deploy/docker/validate-role-config.mjs /usr/local/lib/pc-filebridge/validate-role-config.mjs
COPY --from=tunnel-builder /out/tunnel-client /usr/local/bin/tunnel-client
COPY --from=tunnel-assets /usr/bin/cloudflared /usr/local/bin/cloudflared
COPY --from=tunnel-builder /src/LICENSE /usr/share/pc-filebridge/tunnel-client/LICENSE
COPY deploy/docker/THIRD_PARTY_NOTICES.md /usr/share/pc-filebridge/tunnel-client/THIRD_PARTY_NOTICES.md

RUN chmod 0555 /usr/local/bin/pc-filebridge-entrypoint /usr/local/bin/tunnel-client /usr/local/bin/cloudflared \
    && chmod 0444 /app/mcp/server.mjs /app/config/roots.infrastructure.json \
      /usr/local/lib/pc-filebridge/healthcheck.mjs \
      /usr/local/lib/pc-filebridge/validate-role-config.mjs \
      /usr/share/pc-filebridge/tunnel-client/LICENSE \
      /usr/share/pc-filebridge/tunnel-client/THIRD_PARTY_NOTICES.md

USER 10001:10001

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "/usr/local/lib/pc-filebridge/healthcheck.mjs"]

ENTRYPOINT ["/usr/local/bin/pc-filebridge-entrypoint"]
