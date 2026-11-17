import type { RemoteHostId } from "./hosts";
import { PROVIDERS, type ProviderId } from "./providers";
import { COMPOSER, script, type ToolCall } from "./script";

/**
 * The work the orchestrating agent hands out in the orchestration scene. The sidebar draws one
 * workspace per task and the chat draws the tool calls and the subagent rows from the same list.
 */
export const DELEGATED_TASKS: {
  id: string;
  title: string;
  branch: string;
  provider: Exclude<ProviderId, "claude">;
  host?: RemoteHostId;
}[] = [
  {
    id: "issue-412",
    title: "Fix #412: relay handshake race",
    branch: "fix/relay-handshake-race",
    provider: "codex",
  },
  {
    id: "issue-417",
    title: "Fix #417: menu bar icon on macOS",
    branch: "fix/menu-bar-icon",
    provider: "opencode",
    host: "mac-mini",
  },
  {
    id: "issue-421",
    title: "Fix #421: stale Docker setup docs",
    branch: "docs/docker-setup",
    provider: "pi",
  },
];

/**
 * The orchestrator's Paseo tool calls, one per delegated task. One call creates the worktree
 * workspace and starts the agent in it.
 */
const DELEGATION_CALLS: ToolCall[] = DELEGATED_TASKS.map((task) => ({
  kind: "paseo",
  label: "Create agent",
  detail: `${PROVIDERS[task.provider].name} · ${task.branch}`,
  host: task.host,
}));

/**
 * What the orchestrator looks up before it delegates: the issues to fix, and the agent profiles
 * the user set up, which say which model takes which kind of work.
 */
const LOOKUP_CALLS: ToolCall[] = [
  { kind: "shell", detail: "gh issue list --label ready" },
  { kind: "paseo", label: "List agent profiles" },
];

const REQUEST = "Fix the issues labeled ready, one worktree each.";

/**
 * The orchestration scene: the user asks Claude to fix the ready issues, each in a worktree. Claude
 * lists the issues and the user's agent profiles, picks a model for each issue, and puts the one
 * that needs macOS on another machine. It says that Paseo will notify it when the agents finish.
 * Then the pointer opens the subagents roster.
 */
export const ORCHESTRATION = script([
  { kind: "wait", ms: 200 },
  { kind: "click", target: COMPOSER },
  { kind: "wait", ms: 250 },
  { kind: "type", text: REQUEST },
  { kind: "user", text: REQUEST },
  { kind: "tools", calls: LOOKUP_CALLS },
  {
    kind: "agent",
    text: `I loaded your orchestration preferences: ${PROVIDERS.codex.model} for the hard bug, ${PROVIDERS.opencode.model} for UI, ${PROVIDERS.pi.model} for docs.`,
  },
  {
    kind: "agent",
    text: "I will launch the UI agent on your mac-mini, because that issue is specific to macOS.",
  },
  { kind: "tools", calls: DELEGATION_CALLS },
  {
    kind: "agent",
    text: "All three are launched. Paseo will notify me when each one finishes.",
  },
  // No footer: with it, the transcript and the open roster do not both fit in the pane.
  { kind: "turnEnd" },
  { kind: "click", target: "subagents" },
]);

/** The pointer's click on the subagents pill. It opens the roster of subagents. */
export const SUBAGENTS_CLICK = ORCHESTRATION.click("subagents");

/**
 * How many tasks the orchestrator delegated so far. Each one adds a workspace to the sidebar and a
 * subagent to the composer's pill.
 */
export function tasksDelegated(ms: number): number {
  const delegation = ORCHESTRATION.entries.find(
    (entry) => entry.beat.kind === "tools" && entry.beat.calls === DELEGATION_CALLS,
  );
  return delegation ? ORCHESTRATION.landed(delegation, ms) : 0;
}
