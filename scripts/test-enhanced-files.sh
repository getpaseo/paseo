#!/usr/bin/env bash
set -euo pipefail
TASK_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$TASK_ROOT"
npx vitest run \
  packages/app/src/assistant-file-links/parse.test.ts \
  packages/app/src/assistant-file-links/resolver.test.ts \
  packages/app/src/assistant-file-links/use-file-link.test.tsx \
  packages/app/src/file-access/notification-policy.test.ts \
  packages/app/src/file-access/materialize.native.test.ts \
  packages/app/src/utils/os-notifications.native.test.ts \
  packages/client/src/daemon-client.test.ts \
  packages/server/src/server/file-explorer/task-artifacts.test.ts \
  packages/server/src/server/file-explorer/service.test.ts \
  packages/server/src/server/session/files/workspace-files-session.test.ts \
  packages/server/src/server/agent-attention-policy.test.ts \
  packages/server/src/server/websocket-server.notifications.test.ts \
  packages/server/src/server/authorization/index.test.ts \
  packages/desktop/src/daemon/enhanced-home.test.ts \
  packages/desktop/src/daemon/node-entrypoint-runner.test.ts \
  packages/desktop/src/agent-navigation.test.ts \
  packages/cli/src/commands/open.test.ts \
  --bail=1
npx vitest run packages/server/src/server/bootstrap.smoke.test.ts \
  -t 'accepts the enhanced desktop renderer origin' --bail=1
