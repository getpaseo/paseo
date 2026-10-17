import { resolveOmpDiagnosticPaths } from "../../../server/agent/providers/omp/provider-config.js";
import type {
  AgentHookActivityState,
  AgentHookPluginFileInstallStrategy,
  AgentHookProvider,
} from "../agent-hook-installer.js";

const OMP_EVENT_STATES: Record<string, AgentHookActivityState> = {
  agent_start: "running",
  agent_end: "idle",
  "ask.started": "needs-input",
  "ask.finished": "running",
};

// omp loads default-exported hook factories from <agentDir>/hooks/post/*.js.
// Only the interactive session reports: subagent sessions share the process and
// hooks but have no UI, and their agent_end must not end the terminal's turn.
// Reports are queued so a slow CLI spawn cannot reorder running and idle, and are
// not awaited so the agent loop never waits on Paseo.
export const OMP_HOOK_SOURCE = [
  "let pendingHook = Promise.resolve();",
  "",
  "function runPaseoHook(event) {",
  "  pendingHook = pendingHook.then(async () => {",
  "    try {",
  '      const cli = process.env.PASEO_HOOK_CLI || "paseo";',
  '      const child = Bun.spawn([cli, "hooks", "omp", event], {',
  '        stdin: "ignore",',
  '        stdout: "ignore",',
  '        stderr: "ignore",',
  "      });",
  "      await child.exited;",
  "    } catch {}",
  "  });",
  "}",
  "",
  "export default function paseoTerminalActivity(pi) {",
  "  if (!process.env.PASEO_TERMINAL_ID) return;",
  '  pi.on("agent_start", (_event, ctx) => {',
  '    if (ctx.hasUI) runPaseoHook("agent_start");',
  "  });",
  '  pi.on("agent_end", (_event, ctx) => {',
  '    if (ctx.hasUI) runPaseoHook("agent_end");',
  "  });",
  '  pi.on("tool_call", (event, ctx) => {',
  '    if (ctx.hasUI && event.toolName === "ask") runPaseoHook("ask.started");',
  "  });",
  '  pi.on("tool_result", (event, ctx) => {',
  '    if (ctx.hasUI && event.toolName === "ask") runPaseoHook("ask.finished");',
  "  });",
  "}",
  "",
].join("\n");

const ompHookInstallStrategy: AgentHookPluginFileInstallStrategy = {
  kind: "plugin-file",
  configDir: ({ env, homeDir }) => resolveOmpDiagnosticPaths(env, homeDir).agentDir,
  configFile: "hooks/post/paseo-terminal-activity.js",
  hookMarker: "paseo hooks omp",
  source: OMP_HOOK_SOURCE,
};

export const ompAgentHookProvider: AgentHookProvider = {
  id: "omp",
  events: Object.keys(OMP_EVENT_STATES).map((event) => ({ event })),
  install: ompHookInstallStrategy,
  async resolveActivity({ event }) {
    return OMP_EVENT_STATES[event] ?? null;
  },
};
