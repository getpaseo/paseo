/**
 * Paseo context for a Live Voice call.
 *
 * The realtime model is a conversational front end, not a coding agent. The call
 * is daemon-global and runs on a hidden host session the daemon spawns for it,
 * in a neutral directory rather than any of the user's projects. That host
 * session has exactly two Paseo MCP routing tools injected (see
 * `withRuntimePaseoMcpServer`). They send ordinary Paseo tool calls through the
 * owning client to whichever connected host the user chooses. So the voice
 * model needs to know that Paseo exists, how to select a host safely, and what
 * is running on the host that placed the call.
 *
 * Two levers, both set on `thread/realtime/start`:
 *   - `prompt` replaces the voice model's entire system prompt.
 *   - `initialItems` seeds the conversation with a state snapshot (v3 only).
 * We also pass `includeStartupContext: false` so codex's own synthesized
 * context doesn't compete with this one.
 *
 * Caveat: a user's `experimental_realtime_ws_backend_prompt` in their codex
 * config takes precedence over `prompt`. That ordering lives in codex, so a user
 * who sets it opts out of the Paseo prompt.
 */

/** A `thread/realtime/start` initial item. Roles are codex's allowed set. */
export interface LiveVoiceInitialItem {
  role: "user" | "developer" | "assistant";
  text: string;
}

export interface LiveVoiceStartContext {
  prompt: string;
  initialItems: LiveVoiceInitialItem[];
}

export interface LiveVoiceContextAgent {
  id: string;
  provider: string;
  cwd: string;
  workspaceId?: string | undefined;
  title: string | null;
  lifecycle: string;
}

export interface LiveVoiceContextWorkspace {
  workspaceId: string;
  name: string;
  cwd: string;
  branch: string | null;
}

export interface LiveVoiceContextSnapshot {
  agents: LiveVoiceContextAgent[];
  workspaces: LiveVoiceContextWorkspace[];
  /**
   * Whether the host session launched with Paseo's MCP tools. When false the
   * model must not offer to act on Paseo — it would promise work it has no way
   * to carry out.
   */
  paseoToolsAvailable: boolean;
}

/**
 * codex enforces 128 items and 8,192 estimated tokens per item and in total.
 * Stay well under: this snapshot competes with the user's actual conversation
 * for the model's attention, and a rejected `start` costs the whole call.
 */
const CONTEXT_TOKEN_BUDGET = 3_000;
/** codex's own estimator, so our accounting matches the limit we're checked against. */
const BYTES_PER_TOKEN = 4;
const MAX_LISTED = 20;

const PASEO_VISIBLE_CREATION_RULES = [
  "- Treat every user request to spawn, start, create, or delegate to an agent, or to create a workspace, as a request for a Paseo-visible workspace and agent session. Use only Paseo's workspace and agent-session tools for it.",
  "- Never use runtime-internal agent creation such as spawn_agent, the Agent tool, or collaboration primitives for a user-requested agent. Those agents are invisible to Paseo.",
  "- Never silently fall back to runtime-internal creation. If Paseo creation is unavailable, fails, or does not return the required ids, tell the user that creation did not succeed.",
];

const DELEGATION_WITH_PASEO_TOOLS = [
  "- To get anything done, route it to a host with compatibility=ready. Call list_hosts, choose by label and hostname, call list_paseo_tools_on_host to discover the exact tool and schema, then call run_paseo_tool_on_host with that opaque serverId. Explain when a host requires an upgrade instead of attempting it.",
  "- For a user-requested new workspace and agent, call list_hosts, then use run_paseo_tool_on_host to call create_workspace and create_agent on the chosen host. Pass the returned workspaceId to create_agent; do not let create_agent implicitly choose or create another workspace.",
  "- Give both creations short, descriptive titles. Do not claim success until both workspaceId and agentId are returned: create_workspace must return workspaceId, and create_agent must return agentId plus the same workspaceId. Then report the visible workspace and agent titles.",
  "- Through that routing tool you can prompt an existing agent session in the workspace that owns the work, or create a workspace or session when none fits. You can list, create and archive workspaces; list, create, cancel and prompt agent sessions; open terminals; and manage schedules and heartbeats.",
  "- The state below describes only the host that placed this call. Never assume another host has the same sessions or workspaces; list or inspect them through that host's Paseo tools.",
  "- Host credentials and connection endpoints are intentionally unavailable. Never ask the user for them.",
  "- Route anything that touches code, files, or commands. Answer directly only when the answer is already in this conversation or in the state below, or when you need a clarifying question first.",
  "- Replies from a session you prompted come back to you as text. Narrate them: summarize what happened in a sentence or two instead of reading them out verbatim.",
  "- Anything that takes real work should be started with background set to true. Routed background work is tracked automatically: the call returns as soon as it starts, and a note arrives here when it finishes, errors, or needs permission — so say what you started, then keep talking. Never leave the user in silence waiting for a session to finish, and never poll for status.",
];

const DELEGATION_WITH_LOCAL_PASEO_TOOLS = [
  "- To get anything done, route it to the right place on this machine instead of doing it yourself: prompt an existing agent session in the workspace that owns the work, or create a workspace or session when none fits.",
  "- Your session has Paseo's tools for this machine, so you can list, create and archive workspaces; list, create, cancel and prompt agent sessions; open terminals; and manage schedules and heartbeats.",
  "- For a user-requested new workspace and agent, call create_workspace and then create_agent. Pass the returned workspaceId to create_agent and give both creations short, descriptive titles. Do not claim success until both workspaceId and agentId are returned, with create_agent returning the same workspaceId. Then report the visible workspace and agent titles.",
  "- This client cannot route work to another Paseo host. Do not claim that you can see or control other machines.",
  "- Route anything that touches code, files, or commands. Answer directly only when the answer is already in this conversation or in the state below, or when you need a clarifying question first.",
  "- Replies from a session you prompted come back to you as text. Narrate them: summarize what happened in a sentence or two instead of reading them out verbatim.",
];

const DELEGATION_WITHOUT_PASEO_TOOLS = [
  "- Paseo's own tools are not available to you on this daemon, so you cannot act on Paseo: you cannot prompt, create, cancel, or change anything.",
  "- What you can do is describe what is running from the state below and answer questions about it. If the user asks for work to be done, say plainly that you cannot start it from here — never promise work you have no way to carry out.",
];

function resolveDelegationInstructions(
  paseoToolsAvailable: boolean,
  crossHostRoutingAvailable: boolean,
): string[] {
  if (!paseoToolsAvailable) {
    return DELEGATION_WITHOUT_PASEO_TOOLS;
  }
  return crossHostRoutingAvailable
    ? DELEGATION_WITH_PASEO_TOOLS
    : DELEGATION_WITH_LOCAL_PASEO_TOOLS;
}

export function buildLiveVoicePrompt(
  paseoToolsAvailable: boolean,
  crossHostRoutingAvailable = true,
): string {
  return [
    "You are the voice of Paseo on this machine.",
    "",
    "Paseo runs and monitors AI coding agent sessions on the user's own machine. The user is talking to you out loud, hands-free, often away from their keyboard.",
    "",
    "How you work:",
    "- You are not one of the user's agent sessions. You have a working session of your own, in a plain directory with none of their projects in it, so never do coding work yourself — the sessions you route to are the ones that run with their code.",
    ...PASEO_VISIBLE_CREATION_RULES,
    ...resolveDelegationInstructions(paseoToolsAvailable, crossHostRoutingAvailable),
    "",
    "How to speak:",
    "- Short, plain, spoken sentences. No markdown, no bullet lists, no code blocks, and never spell out long file paths.",
    "- Before starting something slow, say briefly what you are about to do so the user is not left in silence.",
    "- If a transcription sounds garbled or ambiguous, ask instead of guessing.",
    "- Use Paseo's vocabulary: workspace, agent session, provider, terminal, schedule, heartbeat.",
  ].join("\n");
}

function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / BYTES_PER_TOKEN);
}

function describeAgent(agent: LiveVoiceContextAgent): string {
  const name = agent.title?.trim() || "(untitled)";
  return `- ${name} — ${agent.provider}, ${agent.lifecycle}, in ${agent.cwd} (id ${agent.id})`;
}

function describeWorkspace(workspace: LiveVoiceContextWorkspace): string {
  const branch = workspace.branch ? `, branch ${workspace.branch}` : "";
  return `- ${workspace.name} — ${workspace.cwd}${branch}`;
}

/**
 * Sections in priority order. Sessions come first: they are what the user asks
 * about and what work gets routed to. Then the workspace map.
 */
function buildSections(snapshot: LiveVoiceContextSnapshot): string[] {
  const sections: string[] = [];
  if (snapshot.agents.length > 0) {
    const listed = snapshot.agents.slice(0, MAX_LISTED);
    const omitted = snapshot.agents.length - listed.length;
    sections.push(
      [
        `Agent sessions on this daemon (${snapshot.agents.length}):`,
        ...listed.map(describeAgent),
        ...(omitted > 0 ? [`- ...and ${omitted} more.`] : []),
      ].join("\n"),
    );
  }

  if (snapshot.workspaces.length > 0) {
    const listed = snapshot.workspaces.slice(0, MAX_LISTED);
    const omitted = snapshot.workspaces.length - listed.length;
    sections.push(
      [
        `Workspaces on this daemon (${snapshot.workspaces.length}):`,
        ...listed.map(describeWorkspace),
        ...(omitted > 0 ? [`- ...and ${omitted} more.`] : []),
      ].join("\n"),
    );
  }

  return sections;
}

/**
 * One `developer` item per section, dropping whole sections once the budget is
 * spent rather than truncating mid-list — a half-listed workspace reads as a
 * complete list to the model and invites confident wrong answers.
 */
export function buildLiveVoiceInitialItems(
  snapshot: LiveVoiceContextSnapshot,
): LiveVoiceInitialItem[] {
  const items: LiveVoiceInitialItem[] = [];
  let spent = 0;

  for (const section of buildSections(snapshot)) {
    const cost = estimateTokens(section);
    if (spent + cost > CONTEXT_TOKEN_BUDGET) {
      continue;
    }
    spent += cost;
    items.push({ role: "developer", text: section });
  }

  return items;
}

export function buildLiveVoiceStartContext(
  snapshot: LiveVoiceContextSnapshot,
  options: { crossHostRoutingAvailable?: boolean } = {},
): LiveVoiceStartContext {
  return {
    prompt: buildLiveVoicePrompt(
      snapshot.paseoToolsAvailable,
      options.crossHostRoutingAvailable ?? true,
    ),
    initialItems: buildLiveVoiceInitialItems(snapshot),
  };
}
