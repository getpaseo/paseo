import { spawn } from "node:child_process";
import type { Logger } from "pino";

import type { HubcodeHook, CanonicalTool } from "./types.js";
import { AGENT_TOOL_MAP } from "./types.js";

/**
 * In-process executor for Hubcode hooks. Uses the same wire protocol as
 * Claude Code's native hook system (JSON on stdin → JSON on stdout) so one
 * script body works for both the CLI adapter and the GUI/SDK adapter.
 *
 * Hook scripts are expected to:
 *   1. Read a JSON blob from stdin: `{ tool_name, tool_input, tool_response, cwd }`.
 *   2. Emit nothing (silent) or a JSON response with
 *      `{ hookSpecificOutput: { additionalContext: string } }`.
 *   3. Exit within `timeoutMs` — we hard-kill stragglers.
 *
 * Errors, non-zero exits, and timeouts are logged but never throw; a hook
 * crashing must not break the surrounding tool pipeline.
 */

export interface HookExecutionInput {
  toolName: string;
  toolInput: unknown;
  toolResponse: unknown;
  cwd?: string | null;
  sessionId?: string | null;
  /** Canonical agent id so hook scripts can branch per-agent if needed. */
  agentId?: "claude-code" | "codex" | "opencode" | "hubcode-gui";
}

export interface HookExecutionResult {
  hookId: string;
  additionalContext: string | null;
  durationMs: number;
  error?: string;
}

export class HookRuntime {
  private readonly logger: Logger;

  constructor(deps: { logger: Logger }) {
    this.logger = deps.logger.child({ module: "hook-runtime" });
  }

  /**
   * Filter a list of hooks to just the ones whose matcher applies to the
   * current tool call. Agents pass native tool names; we canonicalize via
   * AGENT_TOOL_MAP.
   */
  selectMatching(
    hooks: HubcodeHook[],
    params: {
      agentId: HookExecutionInput["agentId"];
      toolName: string;
      trigger: HubcodeHook["trigger"];
    },
  ): HubcodeHook[] {
    const agentId = params.agentId ?? "hubcode-gui";
    const mapping = AGENT_TOOL_MAP[agentId] ?? AGENT_TOOL_MAP["hubcode-gui"];
    // Reverse index — which canonicals does this native tool fit into?
    const canonicals: CanonicalTool[] = [];
    for (const [canonical, natives] of Object.entries(mapping) as Array<
      [CanonicalTool, string[]]
    >) {
      if (natives.includes(params.toolName)) canonicals.push(canonical);
    }
    return hooks.filter((h) => {
      if (h.trigger !== params.trigger) return false;
      const wanted = h.matcher.tools;
      if (!wanted || wanted.length === 0) return true;
      return canonicals.some((c) => wanted.includes(c));
    });
  }

  async execute(hook: HubcodeHook, input: HookExecutionInput): Promise<HookExecutionResult> {
    const start = Date.now();
    const stdinPayload = JSON.stringify({
      tool_name: input.toolName,
      tool_input: input.toolInput,
      tool_response: input.toolResponse,
      cwd: input.cwd ?? "",
      session_id: input.sessionId ?? "",
      hook_event_name: triggerToEventName(hook.trigger),
    });

    return new Promise<HookExecutionResult>((resolve) => {
      const { cmd, args } = commandFor(hook);
      if (!cmd) {
        resolve({
          hookId: hook.id,
          additionalContext: null,
          durationMs: 0,
          error: `unsupported runtime: ${hook.runtime}`,
        });
        return;
      }
      let settled = false;
      let stdout = "";
      let stderr = "";
      const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          child.kill("SIGKILL");
        } catch {
          // best effort
        }
        resolve({
          hookId: hook.id,
          additionalContext: null,
          durationMs: Date.now() - start,
          error: `timed out after ${hook.timeoutMs}ms`,
        });
      }, hook.timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          hookId: hook.id,
          additionalContext: null,
          durationMs: Date.now() - start,
          error: err.message,
        });
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          this.logger.debug(
            { hookId: hook.id, code, stderr: stderr.slice(0, 500) },
            "hook script exited non-zero",
          );
        }
        resolve({
          hookId: hook.id,
          additionalContext: parseAdditionalContext(stdout),
          durationMs: Date.now() - start,
        });
      });

      try {
        child.stdin.write(stdinPayload);
        child.stdin.end();
      } catch (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          hookId: hook.id,
          additionalContext: null,
          durationMs: Date.now() - start,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }
}

function commandFor(hook: HubcodeHook): { cmd: string | null; args: string[] } {
  switch (hook.runtime) {
    case "node":
      return { cmd: "node", args: [hook.source] };
    case "bash":
      return { cmd: "bash", args: [hook.source] };
    case "python":
      return { cmd: "python3", args: [hook.source] };
    case "inline":
      // Inline execution uses `node -e <source>`. Script is expected to read
      // stdin and write stdout like the file-based variants.
      return { cmd: "node", args: ["-e", hook.source] };
    default:
      return { cmd: null, args: [] };
  }
}

function triggerToEventName(trigger: HubcodeHook["trigger"]): string {
  switch (trigger) {
    case "post-tool-use":
      return "PostToolUse";
    case "pre-tool-use":
      return "PreToolUse";
    case "session-start":
      return "SessionStart";
    case "session-end":
      return "SessionEnd";
  }
}

function parseAdditionalContext(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    const hint = parsed?.hookSpecificOutput?.additionalContext;
    if (typeof hint === "string" && hint.length > 0) return hint;
  } catch {
    // Script wrote non-JSON. Treat raw stdout as the hint (fallback).
    if (trimmed.length > 0 && trimmed.length < 4_000) return trimmed;
  }
  return null;
}
