import path from "node:path";
import { fileURLToPath } from "node:url";

import type { HubcodeHook } from "./types.js";

/**
 * Seed definitions for hooks that ship with Hubcode. Users cannot delete
 * these but can toggle them off. When new built-ins are added, existing
 * installations pick them up on next daemon start.
 */

// `import.meta.url` resolves to the compiled dist path at runtime. The
// bundled hint script lives alongside it in `scripts/`.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveBuiltinScript(relativePath: string): string {
  // `dist/server/server/hooks/builtins.js` → `dist/scripts/<file>`.
  // Three `..` pops: hooks → server → server → dist, then into scripts.
  const scriptRoot = path.resolve(__dirname, "..", "..", "..", "scripts");
  return path.join(scriptRoot, relativePath);
}

export function buildBuiltinHooks(): HubcodeHook[] {
  return [
    {
      id: "hubcode.indexing-hint",
      name: "Indexing Hint",
      description:
        "Suggests crg_* tools when Read/Grep/Glob return more data than needed " +
        "for structural questions. Reduces LLM token spend by steering agents " +
        "toward the pre-built code graph for exploration and impact analysis.",
      author: "builtin",
      scope: "global",
      trigger: "post-tool-use",
      matcher: {
        tools: ["read", "grep", "glob"],
      },
      runtime: "node",
      source: resolveBuiltinScript("claude-code-indexing-hint.mjs"),
      timeoutMs: 5_000,
      conditions: {
        workspaceIndexingEnabled: true,
      },
      tags: ["indexing", "cost-reduction"],
    },
  ];
}

export const BUILTIN_HOOK_IDS = new Set(buildBuiltinHooks().map((h) => h.id));
