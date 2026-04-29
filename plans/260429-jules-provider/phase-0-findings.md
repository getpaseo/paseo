# Phase 0 findings

- Timeline renderer fallback: verified in `packages/app/src/components/agent-stream-view.tsx` (`default` branch returns `null`).
- Jules CLI availability: local `jules` binary is absent, but `npx @google/jules` works.
- CLI version command: `jules version` is supported; `--version` is not.
- `jules remote pull --json` does not exist in `@google/jules` v0.1.42.
- `jules remote new --json` does not exist in `@google/jules` v0.1.42.
- Non-interactive auth commands `jules auth status` and `jules whoami` do not exist.
- `jules remote list --session` works and prints a table.
- Activity stable IDs from `remote pull` remain unverified because pull output is non-JSON text.

## Chosen fallback behavior

- Provider availability uses `remote list --session` success/failure for auth/availability diagnostics.
- CLI wrapper uses table/text parsing for `remote list/new/pull`.
- Polling emits timeline items defensively; unknown activity payloads degrade gracefully.
