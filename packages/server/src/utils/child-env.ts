/**
 * Helpers to sanitize `process.env` before inheriting it into a spawned
 * child process.
 *
 * When Hubcode runs inside the desktop Electron app the parent process
 * exposes a handful of Electron-only variables — notably:
 *
 *   - `ELECTRON_RUN_AS_NODE=1` flips the Electron binary into plain-Node
 *     mode, so a child that re-execs via `process.execPath` becomes Node,
 *     not Electron.
 *   - `ELECTRON_NO_ATTACH_CONSOLE=1` silences console on Windows.
 *   - `ATOM_SHELL_INTERNAL_RUN_AS_NODE`, `ELECTRON_*`, `NODE_OPTIONS`
 *     (loader preloads), `VSCODE_*` / `CODE_*` (when launched from VS Code
 *     tasks) — all leak into the user's agent CLI and cause surprising
 *     failures (spawn EINVAL, wrong binary picked, module resolution errors).
 *
 * Every agent / tool / git spawn inside the daemon should go through
 * `childEnv()` instead of spreading `process.env` directly.
 */

const ELECTRON_ONLY_PREFIXES = ["ELECTRON_", "ATOM_SHELL_", "VSCODE_", "CODE_"] as const;

const ELECTRON_ONLY_KEYS = new Set<string>([
  "ELECTRON_RUN_AS_NODE",
  "ELECTRON_NO_ATTACH_CONSOLE",
  "ELECTRON_NO_ASAR",
  "ATOM_SHELL_INTERNAL_RUN_AS_NODE",
  "GTK_MODULES",
  "ORIGINAL_XDG_CURRENT_DESKTOP",
  // Electron preloads a loader that breaks plain Node children.
  "NODE_OPTIONS",
  // VS Code's integrated terminal injects a preload that's loud and
  // sometimes incompatible with agent CLIs.
  "VSCODE_INJECTION",
  "TERM_PROGRAM",
]);

/**
 * Clone `process.env` (or a supplied env) with Electron- and editor-
 * specific variables stripped. Additions in `extras` win over the base.
 */
export function childEnv(extras?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return mergeChildEnv(process.env, extras);
}

/** Same as `childEnv` but lets callers pass an explicit base env. */
export function mergeChildEnv(
  base: NodeJS.ProcessEnv,
  extras?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (ELECTRON_ONLY_KEYS.has(key)) continue;
    if (ELECTRON_ONLY_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    out[key] = value;
  }
  if (extras) {
    for (const [key, value] of Object.entries(extras)) {
      if (value === undefined) {
        delete out[key];
      } else {
        out[key] = value;
      }
    }
  }
  return out;
}
