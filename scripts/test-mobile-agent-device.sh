#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${PASEO_MOBILE_E2E_STATE_DIR:-${REPO_ROOT}/.dev/agent-device-e2e}"
ARTIFACTS_DIR="${PASEO_MOBILE_E2E_ARTIFACTS_DIR:-${REPO_ROOT}/.dev/agent-device-artifacts}"
METRO_PORT="${PASEO_MOBILE_E2E_METRO_PORT:-8081}"
METRO_PID=0

cleanup() {
  AGENT_DEVICE_STATE_DIR="${STATE_DIR}" agent-device daemon stop --clean >/dev/null 2>&1 || true
  if [[ "${METRO_PID}" -gt 0 ]]; then
    pkill -TERM -P "${METRO_PID}" >/dev/null 2>&1 || true
    kill -TERM "${METRO_PID}" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT INT TERM
cleanup
mkdir -p "${STATE_DIR}" "${ARTIFACTS_DIR}"

METRO_RESULT="$({
  AGENT_DEVICE_STATE_DIR="${STATE_DIR}" agent-device metro prepare \
    --project-root "${REPO_ROOT}/packages/app" \
    --kind expo \
    --port "${METRO_PORT}" \
    --public-base-url "http://127.0.0.1:${METRO_PORT}" \
    --json
})"
printf '%s\n' "${METRO_RESULT}"
METRO_PID="$(printf '%s' "${METRO_RESULT}" | node -e '
  let input = "";
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const result = JSON.parse(input);
    process.stdout.write(String(result.data?.started ? result.data.pid : 0));
  });
')"

AGENT_DEVICE_STATE_DIR="${STATE_DIR}" agent-device prepare ios-runner \
  --platform ios \
  --timeout 120000

AGENT_DEVICE_STATE_DIR="${STATE_DIR}" agent-device test \
  "${REPO_ROOT}/packages/app/e2e/mobile/agent-device" \
  --metro-port "${METRO_PORT}" \
  --timeout 120000 \
  --fail-fast \
  --artifacts-dir "${ARTIFACTS_DIR}"
