#!/bin/sh
set -eu

# Resolve /usr/bin alternatives and user-created symlinks before finding Electron.
launcher=$(readlink -f -- "$0")
executable="${launcher}.bin"

# Node entrypoints are not Chromium processes. Never inject browser flags here.
if [ "${ELECTRON_RUN_AS_NODE:-}" = 1 ]; then
  exec "$executable" "$@"
fi

# Ozone must be selected before Electron initializes the windowing system.
set -f
backend_requested=false
for arg in "$@"; do
  case "$arg" in
    --ozone-platform|--ozone-platform=*|--ozone-platform-hint|--ozone-platform-hint=*) backend_requested=true ;;
  esac
done
backend_value_pending=false
backend_flags=
for flag in ${PASEO_ELECTRON_FLAGS:-}; do
  if [ "$backend_value_pending" = true ]; then
    backend_flags="$backend_flags $flag"
    backend_value_pending=false
    continue
  fi
  case "$flag" in
    --ozone-platform|--ozone-platform-hint)
      backend_flags="$backend_flags $flag"
      backend_requested=true
      backend_value_pending=true
      ;;
    --ozone-platform=*|--ozone-platform-hint=*)
      backend_flags="$backend_flags $flag"
      backend_requested=true
      ;;
  esac
done
if [ -n "$backend_flags" ]; then
  set -- $backend_flags "$@"
fi
if [ -n "${DISPLAY:-}" ] && [ "$backend_requested" = false ]; then
  set -- --ozone-platform=x11 "$@"
fi

for arg in "$@"; do
  if [ "$arg" = '--no-sandbox' ]; then
    export PASEO_DESKTOP_SANDBOX_REASON='requested by --no-sandbox'
    printf '[linux-sandbox] disabled: %s\n' "$PASEO_DESKTOP_SANDBOX_REASON" >&2 || true
    exec "$executable" "$@"
  fi
done

# Match main's whitespace-separated debugging flags without evaluating shell code.
for flag in ${PASEO_ELECTRON_FLAGS:-}; do
  if [ "$flag" = '--no-sandbox' ]; then
    export PASEO_DESKTOP_SANDBOX_REASON='requested by PASEO_ELECTRON_FLAGS'
    printf '[linux-sandbox] disabled: %s\n' "$PASEO_DESKTOP_SANDBOX_REASON" >&2 || true
    exec "$executable" --no-sandbox "$@"
  fi
done

# Map the real UID and create a network namespace as Chromium does. A bare
# unshare --user can succeed under AppArmor while namespace capabilities fail.
if namespace_error=$(unshare --user --map-root-user --net true 2>&1); then
  export PASEO_DESKTOP_SANDBOX_REASON='user namespaces available'
  printf '[linux-sandbox] enabled: %s\n' "$PASEO_DESKTOP_SANDBOX_REASON" >&2 || true
  exec "$executable" "$@"
fi

helper="$(dirname -- "$launcher")/chrome-sandbox"
if [ -x "$helper" ] && [ "$(stat -Lc '%u:%a' -- "$helper")" = '0:4755' ] &&
   grep -q '^NoNewPrivs:[[:space:]]*0$' /proc/self/status; then
  mount_options=$(findmnt -n -o VFS-OPTIONS --target "$helper" 2>/dev/null || true)
  case ",$mount_options," in
    *,nosuid,*|,,) ;;
    *)
      export PASEO_DESKTOP_SANDBOX_REASON='root-owned SUID helper available'
      printf '[linux-sandbox] enabled: %s\n' "$PASEO_DESKTOP_SANDBOX_REASON" >&2 || true
      exec "$executable" "$@"
      ;;
  esac
fi

export PASEO_DESKTOP_SANDBOX_REASON="user namespaces unavailable${namespace_error:+ ($namespace_error)}; no usable SUID helper"
printf '[linux-sandbox] disabled: %s\n' "$PASEO_DESKTOP_SANDBOX_REASON" >&2 || true
exec "$executable" --no-sandbox "$@"
