# Managed CLI Global Install Loop Plan

## Task

Implement a proper desktop-managed CLI install flow for the desktop app.

The current implementation installs a user-local shim and routes through the desktop app binary with `--paseo-cli-shim <state-file>`. The target design is:

- The installed PATH shim must be trivial and stable, like Tailscale.
- The installed PATH shim should forward argv to an inner executable/shim inside the app bundle.
- The inner executable/shim should resolve the bundled Node runtime and bundled `@getpaseo/cli` entrypoint and invoke the CLI directly.
- The CLI should gain Docker-like default connection resolution so the shim does not need to hardcode daemon transport details.
- The desktop install button should attempt a best-effort global install and clearly communicate that a permissions prompt may appear.
- If global install does not succeed, the app must present a fallback dialog with exact platform-specific terminal instructions.

This work must be planned and implemented cleanly, not patched onto the current state-file trampoline design.

## Relevant Code And Current Behavior

- `packages/desktop/src-tauri/src/runtime_manager.rs`
  - Contains managed runtime install logic, CLI shim install/uninstall logic, and the current `try_run_cli_shim_from_args()` trampoline path.
  - Today the installed shim calls the desktop app executable, passes `--paseo-cli-shim <state-file>`, and the app then resolves bundled Node + bundled CLI and execs them.
  - Today macOS/Linux install to `~/.local/bin/paseo`; Windows installs a `.cmd` shim under the user data dir.
- `packages/desktop/src-tauri/src/lib.rs`
  - Exposes `install_cli_shim` / `uninstall_cli_shim` Tauri commands and includes some desktop-side `command -v paseo` checks.
- `packages/app/src/desktop/managed-runtime/managed-runtime.ts`
  - TypeScript bridge for desktop managed-runtime commands.
  - Today `CliShimResult` is only `{ installed, path, message }`.
- `packages/app/src/desktop/components/desktop-updates-section.tsx`
  - Contains the Install CLI / Uninstall CLI button and current status-message handling.
  - Today there is no preflight permission notice and no fallback modal with manual commands.
- `packages/cli`
  - The CLI currently expects explicit host wiring in some flows. It needs to be inspected and updated so that when no host is passed it behaves more like Docker:
    1. use explicit `--host` if provided
    2. otherwise try local socket / local pipe first
    3. then fall back to `localhost:6767`

## Implementation Requirements

### 1. Replace the current installed shim architecture with a two-shim design

Implement two distinct layers:

- Outer PATH shim:
  - Must be extremely simple and stable.
  - It should do nothing except invoke an inner executable or shim within the installed app/bundle and forward argv.
  - It must not embed managed runtime state, a state-file path, runtime id, socket path, or transport details.
  - On macOS, the desired style is comparable to:
    `#!/bin/sh`
    `exec /Applications/Paseo.app/Contents/MacOS/paseo "$@"`
- Inner bundle shim / entrypoint:
  - Lives inside the app bundle / managed runtime and is responsible for finding bundled Node and the bundled CLI entrypoint.
  - It should invoke the bundled CLI directly, as if launching the packaged CLI with bundled Node.
  - It must not route back through the desktop app command trampoline with `--paseo-cli-shim`.

Remove or obsolete the current state-file-based trampoline path if the new direct inner-shim path fully replaces it.

### 2. Make CLI host resolution work by default without shim transport knowledge

Update the CLI so that the launcher does not have to inject managed socket details in the normal case.

Desired behavior when the user runs `paseo` and no host is explicitly passed:

1. If `--host` is passed, use it.
2. Otherwise, try the platform-appropriate local managed/default transport first:
   - Unix socket on macOS/Linux
   - Named pipe on Windows, if supported by the CLI host format
3. If no local transport is available, fall back to `localhost:6767`.

The judge must verify the actual host-resolution code path and ensure it is not just documentation text.

### 3. Add best-effort global install behavior for the desktop-managed CLI

The desktop Install CLI action should attempt to install the outer shim globally in a platform-appropriate location.

Platform expectations:

- macOS:
  - Prefer `/usr/local/bin/paseo`.
  - Attempt a privileged install so the user sees the normal macOS admin-password prompt when needed.
  - The flow should be initiated from the click action.
- Linux:
  - Best effort only.
  - If a reliable privileged install path is not available, fall back to manual instructions.
  - Do not fake success.
- Windows:
  - Best effort only.
  - If protected install cannot be completed automatically, return a manual-instructions path.

Do not silently keep the old user-local install path as the primary desktop behavior on macOS.

### 4. Add explicit user-facing permission guidance before and after the attempt

When the user clicks Install CLI in the desktop UI:

- Immediately show a clear status line or notice saying that a permissions popup may appear to install the CLI globally.
- Do this before awaiting the install attempt, so the user understands what is happening.

If installation fails, or if the backend reports that manual action is required:

- Open a dedicated dialog/modal in the desktop UI.
- The modal should clearly explain:
  - A permissions popup should appear prompting for permission to install the CLI globally.
  - If it does not work, open a terminal and run the provided commands.
- Include a selectable and copyable code block with exact platform-specific commands.

### 5. Return structured install results from the desktop backend

Expand the desktop backend/frontend result shape for CLI install so the UI can make decisions without parsing freeform error strings.

The result must be rich enough to distinguish at least:

- install succeeded automatically
- install failed because elevation was denied
- install could not be attempted automatically on this platform
- manual installation is required

It must also include:

- installed path, when available
- a user-facing summary message
- manual instructions payload, when required

### 6. Manual fallback instructions must be real and platform-specific

The fallback dialog must show platform-specific commands that match the actual chosen launcher architecture.

That means the commands should install or write the simple outer shim that points at the inner app/bundle shim.

The commands must use real paths derived from the installed app/runtime layout, not placeholder pseudo-paths.

They must be quoted correctly for spaces in file paths.

### 7. Preserve or update uninstall behavior coherently

Uninstall CLI must continue to remove the installed outer shim from whatever location the new install flow uses.

If install location or result state changes, update the stored metadata and uninstall behavior accordingly.

### 8. Update or add verification coverage where practical

Add or update tests for the new behavior where practical and already patterned in the codebase.

At minimum, verify:

- any changed TypeScript types and desktop command parsing
- any changed Rust result serialization assumptions
- any changed CLI host-resolution logic

If automated coverage for the privileged install is impractical, document the manual verification path in code comments or test notes near the relevant smoke/integration checks rather than hand-waving it away.

## Constraints

- Do not reintroduce or preserve the current state-file-based app trampoline design unless strictly required for a narrow compatibility bridge.
- Do not parse user-facing error strings in the frontend to determine behavior.
- Do not implement the UI fallback as a generic alert with truncated instructions; use a proper modal/dialog with copyable command text.
- Do not leave macOS as a `~/.local/bin` install target for the primary desktop-managed global install flow.
- Do not skip typecheck. The repo instructions require typecheck after every change.
- Be careful with existing unrelated worktree changes; do not revert unrelated user changes.

## Acceptance Criteria

The judge should mark the loop successful only if all of the following are true:

1. The installed outer shim architecture has been simplified so it is a trivial forwarder to an inner app/bundle shim or executable, with no embedded managed state-file path.
2. The inner app/bundle shim directly invokes bundled Node + bundled CLI, rather than re-entering the desktop app via the current `--paseo-cli-shim` trampoline.
3. CLI default host resolution has been updated in code so that no-host invocation first prefers local transport and then falls back to `localhost:6767`.
4. The desktop Install CLI UI shows an up-front notice that a permissions popup may appear.
5. The desktop install flow returns structured results that distinguish automatic success from manual fallback cases.
6. On failure or manual-required paths, the desktop UI opens a dedicated dialog/modal with copyable platform-specific terminal instructions.
7. macOS best-effort install targets `/usr/local/bin/paseo` and is implemented as a privileged install attempt rather than the old user-local path.
8. Uninstall behavior remains coherent with the new install location and metadata.
9. `npm run typecheck` passes.
10. Any relevant tests added or changed by the implementation pass, or the worker explicitly documents why a test path is not runnable and what was verified instead.

## Hard Acceptance Criteria

The following are non-negotiable. If any one of them is not true in the code, the judge must return `criteria_met: false`.

### H1. Stable outer shim across runtime updates

The installed outer PATH shim must not hardcode a versioned managed-runtime path.

This specifically means:

- The installed outer shim at `/usr/local/bin/paseo` on macOS/Linux, or the Windows outer shim path, must not point directly into `paths.runtime_root` or any runtime-id/version-specific directory.
- Updating the managed runtime to a new runtime id/version must not require reinstalling the outer PATH shim just to keep `paseo` working.
- The outer shim may point at a stable app-bundle executable path or another stable non-versioned path under app-owned state, but not a versioned runtime root.

The judge must inspect the actual generated launcher code paths and fail if the installed shim still embeds a runtime-root-specific target.

### H2. CLI default host resolution must preserve configured non-default TCP daemons

The new CLI default-resolution logic must not discard a configured non-IPC TCP daemon endpoint.

Required order when `--host` is not passed:

1. If an explicit host override is present, use it.
2. Otherwise, if a local IPC target is discoverable, prefer it first.
3. Otherwise, if config or environment resolves to a TCP listen target, use that configured TCP target.
4. Only if none of the above is available, fall back to `localhost:6767`.

This means a user who has intentionally configured the daemon on a non-default TCP endpoint must still have the CLI connect there by default.

The judge must fail if the implementation:

- always falls back to `localhost:6767` after checking only IPC candidates, or
- ignores configured TCP listen values when no IPC target exists.

### H3. Tests must prove both hard cases

Automated verification must cover both failure modes found in review:

- a test or equivalent deterministic proof that the outer shim target remains stable across runtime updates / runtime-id changes, or at minimum that it resolves through a stable path that does not encode the runtime root
- a CLI host-resolution test proving that when no IPC target exists but config/environment specifies a non-default TCP daemon endpoint, that endpoint is chosen before `localhost:6767`

The judge must not accept hand-wavy reasoning in place of these checks.

## Execution Notes For Worker

- Start by tracing the current shim architecture and the CLI host-resolution path before editing.
- Prefer cohesive refactoring over additive patch layers.
- Keep the outer shim intentionally dumb.
- If you need a temporary compatibility bridge, keep it narrow and justify it in code comments or commit notes.
- Run `npm run typecheck` after completing the changes.

## Execution Notes For Judge

- Verify the actual code paths, not just strings or comments.
- Inspect whether the old `--paseo-cli-shim <state-file>` trampoline still remains as the active path. If so, fail unless it is clearly obsolete and no longer used by the installed outer shim flow.
- Verify that the fallback dialog is a real modal/dialog in the UI code and that it contains actionable copyable instructions.
- Verify the install target logic on macOS is `/usr/local/bin/paseo`.
- Verify `npm run typecheck` was run successfully from logs or explicit output artifacts.
