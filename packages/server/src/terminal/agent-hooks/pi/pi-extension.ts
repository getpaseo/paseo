import type { AgentHookPluginFileInstallStrategy } from "../agent-hook-installer.js";

export const PI_EXTENSION_SOURCE = String.raw`import { spawn } from "node:child_process";

const GOAL_STATE_ENTRY_TYPE = "goal-state";
const STOPPED_GOAL_STATUSES = new Set([
  "paused",
  "blocked",
  "usage_limited",
  "budget_limited",
]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasPaseoTerminalTarget(env) {
  return Boolean(
    env.PASEO_TERMINAL_ID &&
      env.PASEO_ACTIVITY_TOKEN &&
      env.PASEO_TERMINAL_ACTIVITY_URL,
  );
}

function isEligible(ctx, env) {
  return (
    ctx.mode === "tui" &&
    env.PI_SUBAGENT_CHILD !== "1" &&
    hasPaseoTerminalTarget(env)
  );
}

function readGoalState(ctx) {
  const entries = ctx.sessionManager?.getBranch?.() ?? [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry.customType !== GOAL_STATE_ENTRY_TYPE) continue;
    if (!isRecord(entry.data)) return { status: null, pending: false };
    const goal = isRecord(entry.data.goal) ? entry.data.goal : null;
    return {
      status: typeof goal?.status === "string" ? goal.status : null,
      pending:
        (Array.isArray(entry.data.queue) && entry.data.queue.length > 0) ||
        isRecord(entry.data.pendingAction),
    };
  }
  return { status: null, pending: false };
}

function spawnPaseoHook(event, env) {
  try {
    const child = spawn(env.PASEO_HOOK_CLI || "paseo", ["hooks", "pi", event], {
      env,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", () => {});
    child.unref();
  } catch {
    // Terminal activity is best effort and must never interrupt Pi.
  }
}

export function registerPaseoTerminalActivity(pi, options = {}) {
  const env = options.env ?? process.env;
  const report = options.report ?? ((event) => spawnPaseoHook(event, env));
  const settleDelayMs = options.settleDelayMs ?? 50;
  let enabled = false;
  let running = false;
  let waitingForInput = false;
  let generation = 0;
  let settleTimer;

  function cancelPendingSettle() {
    generation += 1;
    if (settleTimer !== undefined) {
      clearTimeout(settleTimer);
      settleTimer = undefined;
    }
  }

  pi.on("session_start", (_event, ctx) => {
    cancelPendingSettle();
    enabled = isEligible(ctx, env);
    running = false;
    waitingForInput = false;
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!isEligible(ctx, env)) return;
    enabled = true;
    cancelPendingSettle();
    running = true;
    waitingForInput = false;
    report("agent_start");
  });

  pi.on("tool_execution_start", (event, ctx) => {
    if (!enabled || !running || event.toolName !== "ask_user" || !isEligible(ctx, env)) return;
    waitingForInput = true;
    report("needs_input");
  });

  pi.on("tool_execution_end", (event, ctx) => {
    if (!enabled || !waitingForInput || event.toolName !== "ask_user" || !isEligible(ctx, env)) {
      return;
    }
    waitingForInput = false;
    report("resume");
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (!enabled || !running || !isEligible(ctx, env)) return;
    cancelPendingSettle();
    const settleGeneration = generation;
    settleTimer = setTimeout(() => {
      settleTimer = undefined;
      if (generation !== settleGeneration || ctx.isIdle?.() !== true) return;

      const goal = readGoalState(ctx);
      if (
        goal.status === "active" ||
        goal.status === "queued" ||
        goal.pending ||
        (goal.status && STOPPED_GOAL_STATUSES.has(goal.status))
      ) {
        running = false;
        waitingForInput = true;
        report("needs_input");
        return;
      }

      running = false;
      waitingForInput = false;
      report("agent_settled");
    }, settleDelayMs);
  });

  pi.on("session_shutdown", () => {
    cancelPendingSettle();
    enabled = false;
    running = false;
    waitingForInput = false;
  });
}

export default function paseoTerminalActivityExtension(pi) {
  registerPaseoTerminalActivity(pi);
}
`;

export function createPiExtensionInstallStrategy(): AgentHookPluginFileInstallStrategy {
  return {
    kind: "plugin-file",
    configDir: ".pi/agent",
    configFile: "extensions/paseo-terminal-activity.ts",
    configDirEnvOverride: "PI_CODING_AGENT_DIR",
    configDirEnvOverrideResolution: "user-path",
    hookMarker: "hooks pi",
    source: PI_EXTENSION_SOURCE,
  };
}
