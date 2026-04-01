#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)"

echo "🚀 paseo: bootstrapping project..."

# ---------------------------------------------------------------------------
# 1. Install dependencies
# ---------------------------------------------------------------------------
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules ]; then
  echo "📦 Installing dependencies (npm ci)..."
  npm ci --quiet
else
  echo "✅ node_modules up-to-date, skipping npm ci"
fi

# ---------------------------------------------------------------------------
# 2. Build @getpaseo/highlight  (depended on by relay, server, cli)
# ---------------------------------------------------------------------------
if [ ! -f packages/highlight/dist/index.js ] || \
   [ packages/highlight/src -nt packages/highlight/dist 2>/dev/null ]; then
  echo "🔨 Building @getpaseo/highlight..."
  npm run build --workspace=@getpaseo/highlight --quiet
else
  echo "✅ @getpaseo/highlight already built, skipping"
fi

# ---------------------------------------------------------------------------
# 3. Build @getpaseo/relay  (depended on by server at runtime)
# ---------------------------------------------------------------------------
if [ ! -d packages/relay/dist ] || \
   [ packages/relay/src -nt packages/relay/dist 2>/dev/null ]; then
  echo "🔨 Building @getpaseo/relay..."
  npm run build --workspace=@getpaseo/relay --quiet
else
  echo "✅ @getpaseo/relay already built, skipping"
fi

# ---------------------------------------------------------------------------
# 4. Build @getpaseo/server  (the main daemon)
# ---------------------------------------------------------------------------
if [ ! -d packages/server/dist ] || \
   [ packages/server/src -nt packages/server/dist 2>/dev/null ]; then
  echo "🔨 Building @getpaseo/server..."
  npm run build --workspace=@getpaseo/server --quiet
else
  echo "✅ @getpaseo/server already built, skipping"
fi

# ---------------------------------------------------------------------------
# 5. Copy server .env if coming from a worktree setup
#    (PASEO_SOURCE_CHECKOUT_PATH is set by the worktree tooling)
# ---------------------------------------------------------------------------
if [ -n "${PASEO_SOURCE_CHECKOUT_PATH:-}" ] && \
   [ ! -f packages/server/.env ] && \
   [ -f "${PASEO_SOURCE_CHECKOUT_PATH}/packages/server/.env" ]; then
  echo "🔧 Copying server .env from source checkout..."
  cp "${PASEO_SOURCE_CHECKOUT_PATH}/packages/server/.env" packages/server/.env
fi

echo "✨ paseo: bootstrap complete — run 'npm run dev' to start"
exit 0
