import type { CommandError } from "../../output/index.js";

type AgentProcessControlAction = "stop" | "restart";

export function rejectAgentProcessControl(
  action: AgentProcessControlAction,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!env.PASEO_AGENT_ID?.trim()) {
    return;
  }

  const error: CommandError = {
    code: "UNSAFE_AGENT_DAEMON_PROCESS_CONTROL",
    message: `A managed Paseo agent cannot run 'paseo daemon ${action}' safely.`,
    details:
      "Use the restart_daemon Paseo tool. The supervisor will restart the worker and monitor its heartbeat.",
  };
  throw error;
}
