/**
 * Paseo context for a Live Voice call.
 *
 * The realtime model is a conversational front end, not a coding agent. The call
 * is daemon-global and runs on a hidden host session the daemon spawns for it,
 * in a neutral directory rather than any of the user's projects. That host
 * session has only Paseo's MCP routing tools injected (see
 * `withRuntimePaseoMcpServer`). They send ordinary Paseo tool calls through the
 * owning client to whichever connected host the user chooses. So the voice
 * model needs to know that Paseo exists, how to select a host safely, and what
 * is running on the host that placed the call.
 *
 * It also needs the exact names of the tools it will reach for. Discovering them
 * costs a model turn each, and the user hears silence for every one.
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

import { LIVE_VOICE_ALL_HOSTS_READ_TOOLS } from "./live-voice-fanout-tools.js";

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

const AUTHORITATIVE_PASEO_STATE_RULES = [
  "- Treat Paseo MCP results as authoritative. Your own working session's collaboration or subagent tree is not Paseo's agent list. Never infer Paseo state from OS processes, desktop screenshots, or local Codex session logs.",
  "- Use those fallback sources only if Paseo MCP is unavailable or a Paseo MCP call fails, and explicitly tell the user what fallback you used and why.",
];

const AUTHORITATIVE_PASEO_STATE_WITH_ROUTING = [
  "- For any question about Paseo hosts, workspaces, agent sessions, their status, or what an agent said, did, or is doing, use Paseo MCP first: run_paseo_tool_on_all_hosts when the question spans machines, and reads like get_agent_status or get_agent_activity on the machine that owns the session; use list_pending_permissions when work may be blocked.",
  ...AUTHORITATIVE_PASEO_STATE_RULES,
];

const AUTHORITATIVE_LOCAL_PASEO_STATE = [
  "- For any question about this Paseo host, its workspaces, agent sessions, their status, or what an agent said, did, or is doing, use Paseo MCP first. Read with list_agents, get_agent_status, get_agent_activity, or list_pending_permissions as appropriate instead of prompting a session.",
  ...AUTHORITATIVE_PASEO_STATE_RULES,
];

/**
 * Read tools, spelled out.
 *
 * The model's cheapest way to answer "what did it say?" is a read, but nothing
 * else in this prompt names one, and prompting a session to ask it what it did
 * costs a whole turn and writes the question into the session's own history.
 * These lines exist so the model does not have to discover that shape by
 * accident through tool discovery.
 */
const READ_BEFORE_PROMPTING = [
  "- Prompting a session to ask what it did costs it a full turn and adds your question to its history. Prompt only to give a session new work; read for everything else.",
  "- The state below is a snapshot from when this call started, so it goes stale. Re-read before answering a question about what is running now.",
];

/**
 * Exact tool names, handed over rather than discovered.
 *
 * Every discovery round trip is a turn the user spends listening to nothing,
 * and the model has no way to know these names are stable unless it is told. So
 * without this it opens each request by asking what tools exist, and a
 * multi-word guess at `query` narrows to nothing, costing another turn on top.
 * Anything not listed here is still discoverable.
 *
 * Structured rather than prose because the prompt calls these "exact and
 * stable", which nothing in this file can guarantee — a test holds every entry
 * against the real catalog. The first version of this list already named a tool
 * that does not exist on this daemon (`snooze_workspace`, present only in newer
 * builds), and a wrong name here costs the user a failed turn and an apology.
 */
export interface LiveVoiceCanonicalTool {
  name: string;
  /** The arguments worth spelling out — required ones and identifying ids. */
  args?: readonly string[];
}

export const LIVE_VOICE_CANONICAL_TOOLS: readonly LiveVoiceCanonicalTool[] = [
  { name: "list_workspaces" },
  { name: "create_workspace" },
  { name: "archive_workspace", args: ["workspaceId"] },
  { name: "rename_workspace", args: ["workspaceId", "title"] },
  { name: "list_agents" },
  { name: "create_agent", args: ["workspaceId", "provider", "initialPrompt", "title"] },
  { name: "send_agent_prompt", args: ["agentId", "prompt"] },
  { name: "get_agent_status", args: ["agentId"] },
  { name: "get_agent_activity", args: ["agentId"] },
  { name: "cancel_agent", args: ["agentId"] },
  { name: "archive_agent", args: ["agentId"] },
  { name: "list_pending_permissions" },
  { name: "respond_to_permission", args: ["agentId", "requestId", "response"] },
  { name: "list_terminals" },
  { name: "create_terminal" },
  { name: "list_schedules" },
  { name: "create_schedule" },
];

function describeCanonicalTool(tool: LiveVoiceCanonicalTool): string {
  return tool.args?.length ? `${tool.name}{${tool.args.join(",")}}` : tool.name;
}

const CANONICAL_PASEO_TOOL_NAMES = [
  `- These Paseo tool names and their key arguments are exact and stable. Call them straight away instead of looking them up: ${LIVE_VOICE_CANONICAL_TOOLS.map(describeCanonicalTool).join(", ")}.`,
  "- Look a tool up only when it is not in that list, and then pass one exact toolName. The query argument is a keyword filter, not a sentence.",
];

/**
 * What the model cannot work out from a tool schema.
 *
 * A tool's description is read once the model is already considering that tool.
 * These lines are for the decision before it: how many machines there are, what
 * reaching one costs, and which shape of call answers the whole question. The
 * rationale behind the fan-out allowlist is deliberately left out — the model
 * needs to know which reads fan out, not why the boundary was drawn there.
 */
const CROSS_HOST_REACH = [
  "",
  "The user's machines, and what a call costs:",
  "- The state below is only the machine that placed this call. Every other machine of theirs exists to you only through these tools; there is no other way in and no cached copy of what is on them.",
  "- What the user feels is the number of calls you make, not how much each one does, because they wait through every one in silence. Prefer the call that answers the whole question: one that reads every machine beats five that each read one.",
  `- These reads go to every machine at once through run_paseo_tool_on_all_hosts: ${LIVE_VOICE_ALL_HOSTS_READ_TOOLS.join(", ")}. Everything else runs on one named machine through run_paseo_tool_on_host, so one sentence from the user can never change several machines at once.`,
  "- A result can name machines that have no answer, in two different ways. unavailableHosts could not be reached — say you could not see them. erroredHosts answered but that one read failed there — say what failed, and expect these when you fan out an id to find which machine owns it. Neither ever means the machine held nothing.",
];

/**
 * The shortest correct path for the handful of things people actually say to a
 * voice assistant. Without these the model reasons its way to a working but
 * long route — the archive request that prompted this took ten round trips.
 */
const ROUTED_RECIPES = [
  "",
  "Recipes for the usual requests. Each is one or two tool calls; a longer path is you keeping the user waiting.",
  '- The user names a workspace ("archive the Refresh Paseo assembly workspace"): call find_workspace with the name as they said it, then run_paseo_tool_on_host with the serverId and workspaceId it returns. Do not call list_hosts or list_workspaces for this.',
  "- find_workspace tells you how sure it is. Act on unique_exact. On ambiguous_exact, more than one machine has a workspace by that name, so say which and ask — never pick one yourself for archiving or anything else destructive. On unique_partial or ambiguous_partial nothing matched exactly, so say what you found and confirm first. On none, say nothing matched, and mention any host it could not reach.",
  "- New work in a workspace the user names: find_workspace, then send_agent_prompt or create_agent against the serverId and workspaceId it returns.",
  '- The user asks about their machines as a whole ("what\'s running?", "is anything waiting on me?"): one run_paseo_tool_on_all_hosts call with list_agents or list_pending_permissions — do not ask which machine they meant.',
];

const DELEGATION_WITH_PASEO_TOOLS = [
  "- To get anything done, route it to a host with compatibility=ready: call run_paseo_tool_on_host with that host's opaque serverId, which find_workspace or list_hosts gives you. Explain when a host requires an upgrade instead of attempting it.",
  ...CANONICAL_PASEO_TOOL_NAMES,
  "- For a user-requested new workspace and agent, call list_hosts, then use run_paseo_tool_on_host to call create_workspace and create_agent on the chosen host. Pass the returned workspaceId to create_agent; do not let create_agent implicitly choose or create another workspace.",
  "- Give both creations short, descriptive titles. Do not claim success until both workspaceId and agentId are returned: create_workspace must return workspaceId, and create_agent must return agentId plus the same workspaceId. Then report the visible workspace and agent titles.",
  "- Through that routing tool you can prompt an existing agent session in the workspace that owns the work, or create a workspace or session when none fits. You can list, create and archive workspaces; list, create, cancel and prompt agent sessions; open terminals; and manage schedules and heartbeats.",
  "- Host credentials and connection endpoints are intentionally unavailable. Never ask the user for them.",
  "- Route anything that touches code, files, or commands. Answer directly only when the answer is already in this conversation or in the state below, or when you need a clarifying question first.",
  "- Replies from a session you prompted come back to you as text. Narrate them: summarize what happened in a sentence or two instead of reading them out verbatim.",
  ...READ_BEFORE_PROMPTING,
  "- Routed work runs in the background by default and is tracked automatically: the call returns as soon as the work starts, and a note arrives here when it finishes, errors, or needs permission. Say what you started, then keep talking. Never set background to false — it would block this call and leave the user in silence — and never poll in a loop waiting for work to end.",
  ...CROSS_HOST_REACH,
  ...ROUTED_RECIPES,
];

const DELEGATION_WITH_LOCAL_PASEO_TOOLS = [
  "- To get anything done, route it to the right place on this machine instead of doing it yourself: prompt an existing agent session in the workspace that owns the work, or create a workspace or session when none fits.",
  "- Your session has Paseo's tools for this machine, so you can list, create and archive workspaces; list, create, cancel and prompt agent sessions; open terminals; and manage schedules and heartbeats.",
  ...CANONICAL_PASEO_TOOL_NAMES,
  "- When the user names a workspace, match it against list_workspaces yourself. Act on an exact title or directory match; if more than one matches, or none does exactly, say what you found and ask before archiving or anything else destructive.",
  "- For a user-requested new workspace and agent, call create_workspace and then create_agent. Pass the returned workspaceId to create_agent and give both creations short, descriptive titles. Do not claim success until both workspaceId and agentId are returned, with create_agent returning the same workspaceId. Then report the visible workspace and agent titles.",
  "- This client cannot route work to another Paseo host. Do not claim that you can see or control other machines.",
  "- Route anything that touches code, files, or commands. Answer directly only when the answer is already in this conversation or in the state below, or when you need a clarifying question first.",
  "- Replies from a session you prompted come back to you as text. Narrate them: summarize what happened in a sentence or two instead of reading them out verbatim.",
  ...READ_BEFORE_PROMPTING,
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

export interface LiveVoicePromptOptions {
  paseoToolsAvailable: boolean;
  crossHostRoutingAvailable?: boolean;
  /** The call will hear about agents the user started outside it. */
  ambientAgentReports?: boolean;
  /** The user's own standing instruction for those reports, verbatim. */
  ambientAgentGuidance?: string | undefined;
}

/**
 * The guidance is the user talking to their own voice assistant about their own
 * machines, so it is quoted rather than interpreted. It is bounded only because
 * it competes with the rest of the prompt for the call's context budget.
 */
const MAX_AMBIENT_GUIDANCE_LENGTH = 600;

function buildAmbientAgentReportInstructions(guidance: string | undefined): string[] {
  const lines = [
    "",
    "Reports about work you did not start:",
    "- You will also hear when the user's own agent sessions finish a turn, stop with an error, or need permission — on any machine of theirs you can see, not just this one. Nobody asked you for these, and they arrive whenever the work happens to end.",
    "- Each one is your judgement call: say it, hold it until a natural gap, or say nothing at all. Silence is a valid response and never needs to be acknowledged.",
    "- These reports tell you an outcome, not the details. If the user wants more, read the session rather than prompting it.",
  ];
  const trimmed = guidance?.trim();
  if (trimmed) {
    const bounded =
      trimmed.length <= MAX_AMBIENT_GUIDANCE_LENGTH
        ? trimmed
        : `${trimmed.slice(0, MAX_AMBIENT_GUIDANCE_LENGTH)}…`;
    lines.push(
      `- The user has told you how they want these handled: "${bounded}". Follow that over your own judgement.`,
    );
  }
  return lines;
}

export function buildLiveVoicePrompt(options: LiveVoicePromptOptions): string {
  const crossHostRoutingAvailable = options.crossHostRoutingAvailable ?? true;
  let authoritativeStateInstructions: string[] = [];
  if (options.paseoToolsAvailable) {
    authoritativeStateInstructions = crossHostRoutingAvailable
      ? AUTHORITATIVE_PASEO_STATE_WITH_ROUTING
      : AUTHORITATIVE_LOCAL_PASEO_STATE;
  }
  return [
    "You are the voice of Paseo on this machine.",
    "",
    "Paseo runs and monitors AI coding agent sessions on the user's own machine. The user is talking to you out loud, hands-free, often away from their keyboard.",
    "",
    "How you work:",
    "- You are the user's chief of staff, not one of their agent sessions. Your job is to be an intermediary to their full text-based agent sessions: route work to them, read what they produce, and report back in plain speech.",
    ...authoritativeStateInstructions,
    "- You have a working session of your own, in a plain directory with none of their projects in it, so never do coding work yourself — the sessions you route to are the ones that run with their code.",
    ...PASEO_VISIBLE_CREATION_RULES,
    ...resolveDelegationInstructions(options.paseoToolsAvailable, crossHostRoutingAvailable),
    ...(options.ambientAgentReports
      ? buildAmbientAgentReportInstructions(options.ambientAgentGuidance)
      : []),
    "",
    "How to speak:",
    "- Short, plain, spoken sentences. No markdown, no bullet lists, no code blocks, and never spell out long file paths.",
    "- Be quick and responsive. Answer from what you already have or can read fast; only take a slow path when nothing faster can answer.",
    "- Before starting something slow, say briefly what you are about to do so the user is not left in silence, and keep talking to them rather than going quiet while it runs.",
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
  options: {
    crossHostRoutingAvailable?: boolean;
    ambientAgentReports?: boolean;
    ambientAgentGuidance?: string | undefined;
  } = {},
): LiveVoiceStartContext {
  return {
    prompt: buildLiveVoicePrompt({
      paseoToolsAvailable: snapshot.paseoToolsAvailable,
      crossHostRoutingAvailable: options.crossHostRoutingAvailable ?? true,
      ...(options.ambientAgentReports ? { ambientAgentReports: true } : {}),
      ...(options.ambientAgentGuidance
        ? { ambientAgentGuidance: options.ambientAgentGuidance }
        : {}),
    }),
    initialItems: buildLiveVoiceInitialItems(snapshot),
  };
}
