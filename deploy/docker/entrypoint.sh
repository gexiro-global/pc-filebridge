#!/bin/sh
set -eu

api_key_file="${OPENAI_API_KEY_FILE:-/run/pc-filebridge-secrets/OPENAI_API_KEY}"
tunnel_id_file="${TUNNEL_ID_FILE:-/run/pc-filebridge-secrets/TUNNEL_ID}"
expected_tunnel_name="${EXPECTED_TUNNEL_NAME:-}"
filebridge_role="${FILEBRIDGE_ROLE:-}"

fail() {
  printf '%s\n' "PC_FILEBRIDGE_STARTUP_FAIL code=$1" >&2
  exit 1
}

[ -r "$api_key_file" ] && [ -s "$api_key_file" ] || fail API_KEY_UNAVAILABLE
[ -r "$tunnel_id_file" ] && [ -s "$tunnel_id_file" ] || fail TUNNEL_ID_UNAVAILABLE
[ -r "$FILEBRIDGE_CONFIG" ] && [ -s "$FILEBRIDGE_CONFIG" ] || fail CONFIG_UNAVAILABLE
[ "$filebridge_role" = "infrastructure" ] || fail ROLE_INVALID
[ "$expected_tunnel_name" = "PC FileBridge - Infrastructure" ] || fail EXPECTED_TUNNEL_NAME_INVALID
node /usr/local/lib/pc-filebridge/validate-role-config.mjs "$FILEBRIDGE_CONFIG" >/dev/null 2>&1 \
  || fail INFRASTRUCTURE_CONFIG_INVALID

tunnel_id="$(tr -d '\r\n' < "$tunnel_id_file")"
case "$tunnel_id" in
  tunnel_*) ;;
  *) fail TUNNEL_ID_INVALID ;;
esac
case "$tunnel_id" in
  *[!A-Za-z0-9_-]*) fail TUNNEL_ID_INVALID ;;
esac

umask 077
metadata_file="/tmp/pc-filebridge-tunnel-metadata.json"
runtime_key="$(tr -d '\r\n' < "$api_key_file")"
metadata_ok=false
attempt=1
while [ "$attempt" -le 3 ]; do
  if CONTROL_PLANE_API_KEY="$runtime_key" /usr/local/bin/tunnel-client admin --json tunnels get "$tunnel_id" > "$metadata_file" 2>/dev/null; then
    metadata_ok=true
    break
  fi
  attempt=$((attempt + 1))
  [ "$attempt" -le 3 ] && sleep 2
done
runtime_key=
[ "$metadata_ok" = true ] || fail TUNNEL_METADATA_UNAVAILABLE
actual_tunnel_name="$(node -e 'const fs=require("fs");const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String(value.name||""))' "$metadata_file")"
rm -f "$metadata_file"
[ "$actual_tunnel_name" = "$expected_tunnel_name" ] || fail TUNNEL_ROLE_MISMATCH
actual_tunnel_name=

export CONTROL_PLANE_TUNNEL_ID="$tunnel_id"

exec /usr/local/bin/tunnel-client run \
  --control-plane.api-key "file:${api_key_file}" \
  --mcp.command "command=node /app/mcp/server.mjs,channel=main" \
  --health.listen-addr "$HEALTH_LISTEN_ADDR" \
  --log.format "$LOG_FORMAT" \
  --log.level "$LOG_LEVEL"
