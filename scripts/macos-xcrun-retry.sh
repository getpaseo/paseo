#!/bin/bash
set -euo pipefail

# Retries transient Apple network errors for `xcrun stapler staple` and
# `xcrun notarytool submit` without rebuilding the signed macOS app.
# Compatible with macOS's default bash 3.2.

real_xcrun="${PASEO_REAL_XCRUN:?PASEO_REAL_XCRUN must point to the real xcrun binary}"

is_transient_apple_network_error() {
  local file="$1"
  grep -Eq \
    'NSURLErrorDomain|HTTPError\(statusCode: nil|HTTPError\(statusCode: Optional\(5[0-9][0-9]\)|HTTP status code: 5[0-9][0-9]' \
    "$file"
}

extract_submission_id() {
  local file="$1"
  local match
  match="$(grep -Eo '/notary/v2/submissions/[0-9a-fA-F-]{36}' "$file" | head -n 1 || true)"
  if [[ -n "$match" ]]; then
    printf '%s\n' "${match##*/}"
    return 0
  fi
  return 1
}

run_stapler_with_retry() {
  local output
  output="$(mktemp)"
  trap 'rm -f "$output"' RETURN

  local attempt status
  for attempt in 1 2 3 4; do
    if "$real_xcrun" "$@" >"$output" 2>&1; then
      cat "$output"
      return 0
    else
      status=$?
    fi
    cat "$output"
    if [[ "$status" != 68 || "$attempt" == 4 ]] || ! is_transient_apple_network_error "$output"; then
      return "$status"
    fi
    echo "::warning::Apple staple connection lost; retrying the same signed app ($attempt/4)" >&2
    sleep 30
  done
}

run_notarytool_submit_with_retry() {
  # @electron/notarize merges stdout and stderr before calling JSON.parse, so
  # keep retry attempts silent and emit only the final attempt's output.
  local output
  output="$(mktemp)"
  trap 'rm -f "$output"' RETURN

  local has_wait=false
  local skipped_file=false
  local wait_args=()
  local arg
  local idx=0
  for arg in "$@"; do
    idx=$((idx + 1))
    if (( idx <= 2 )); then
      continue
    fi
    if [[ "$arg" == "--wait" ]]; then
      has_wait=true
      continue
    fi
    if [[ "$skipped_file" == false && "$arg" != -* ]]; then
      skipped_file=true
      continue
    fi
    wait_args+=("$arg")
  done

  local attempt status submission_id=""
  for attempt in 1 2 3; do
    if "$real_xcrun" "$@" >"$output" 2>&1; then
      cat "$output"
      return 0
    else
      status=$?
    fi

    if ! is_transient_apple_network_error "$output"; then
      cat "$output"
      return "$status"
    fi

    if [[ "$has_wait" == true ]]; then
      submission_id="$(extract_submission_id "$output" || true)"
      if [[ -n "$submission_id" ]]; then
        break
      fi
    fi

    if [[ "$attempt" == 3 ]]; then
      cat "$output"
      return "$status"
    fi

    sleep 30
  done

  if [[ -n "$submission_id" ]]; then
    local wait_attempt
    for wait_attempt in 1 2 3 4 5 6; do
      sleep 30
      if "$real_xcrun" notarytool wait "$submission_id" "${wait_args[@]}" >"$output" 2>&1; then
        cat "$output"
        return 0
      else
        status=$?
      fi

      if [[ "$wait_attempt" == 6 ]] || ! is_transient_apple_network_error "$output"; then
        cat "$output"
        return "$status"
      fi
    done
  fi

  cat "$output"
  return "${status:-1}"
}

if [[ "${1:-}" == "stapler" && "${2:-}" == "staple" ]]; then
  run_stapler_with_retry "$@"
  exit $?
fi

if [[ "${1:-}" == "notarytool" && "${2:-}" == "submit" ]]; then
  run_notarytool_submit_with_retry "$@"
  exit $?
fi

exec "$real_xcrun" "$@"
