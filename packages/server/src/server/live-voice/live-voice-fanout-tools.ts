/**
 * The tools a Live Voice call may run on every host at once.
 *
 * An allowlist rather than a denylist, so a tool added later is not fannable
 * until someone decides it should be. Mass mutation is the thing being kept out:
 * "archive it on all of them" is a sentence a user can say by accident, and one
 * misheard word should not reach five machines. Anything that changes state goes
 * through `run_paseo_tool_on_host`, one named host at a time.
 *
 * This is enforced on the requesting side rather than on the target daemon
 * because it is an ergonomic guard, not a privilege boundary — the model can
 * already mutate a single host, and gains no authority by naming it.
 *
 * It lives in its own module because both the fan-out tool and the call's prompt
 * name these tools, and a prompt that advertises a tool the fan-out rejects
 * costs the user a wasted turn.
 */
export const LIVE_VOICE_ALL_HOSTS_READ_TOOLS: readonly string[] = [
  "capture_terminal",
  "get_agent_activity",
  "get_agent_status",
  "inspect_provider",
  "inspect_schedule",
  "list_agents",
  "list_models",
  "list_paseo_tools",
  "list_pending_permissions",
  "list_providers",
  "list_schedules",
  "list_terminals",
  "list_workspace_scripts",
  "list_workspaces",
  "schedule_logs",
];

const allHostsReadTools = new Set(LIVE_VOICE_ALL_HOSTS_READ_TOOLS);

export function canRunOnAllLiveVoiceHosts(toolName: string): boolean {
  return allHostsReadTools.has(toolName);
}
