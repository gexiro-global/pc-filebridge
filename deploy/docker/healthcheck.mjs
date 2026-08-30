#!/usr/bin/env node

const listenAddress = process.env.HEALTH_LISTEN_ADDR ?? "127.0.0.1:8080";
const version = process.env.PC_FILEBRIDGE_VERSION ?? "unknown";
const maximumAge = Number(process.env.TUNNEL_HEALTH_MAX_AGE_SECONDS ?? "180");

if (!Number.isFinite(maximumAge) || maximumAge < 30 || maximumAge > 3600) {
  fail("INVALID_MAX_AGE");
}

try {
  const [readyResponse, metricsResponse] = await Promise.all([
    fetch(`http://${listenAddress}/readyz`),
    fetch(`http://${listenAddress}/metrics`),
  ]);
  if (!readyResponse.ok) fail("LOCAL_READY_FAILED");
  if (!metricsResponse.ok) fail("METRICS_UNAVAILABLE");

  const metrics = await metricsResponse.text();
  const match = metrics.match(
    /^commands_poll_last_successful_timestamp_seconds(?:\{[^\n]*\})?\s+([0-9.eE+-]+)$/mu,
  );
  if (!match) fail("POLL_SUCCESS_MISSING");

  const lastSuccess = Number(match[1]);
  const age = Date.now() / 1000 - lastSuccess;
  if (!Number.isFinite(lastSuccess) || lastSuccess <= 0 || !Number.isFinite(age)) {
    fail("POLL_SUCCESS_INVALID");
  }
  if (age < -300 || age > maximumAge) {
    fail("POLL_SUCCESS_STALE");
  }
} catch {
  fail("CHECK_EXCEPTION");
}

process.stdout.write(`PC_FILEBRIDGE_HEALTH_PASS version=${version}\n`);
process.exit(0);

function fail(code) {
  process.stderr.write(`PC_FILEBRIDGE_HEALTH_FAIL code=${code}\n`);
  process.exit(1);
}
