/**
 * Paseo context for a Live Voice call.
 *
 * The realtime model is a conversational front end, not the coding agent. Every
 * request it delegates becomes an ordinary turn on the attached agent session,
 * and that session already has Paseo's own MCP tools injected (see
 * `withRuntimePaseoMcpServer`). So the voice model needs no tools of its own —
 * codex has no way to give the realtime model client-defined tools regardless —
 * it needs to know that Paseo exists, what it can ask for, and what is running
 * right now.
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
  attachedAgentId: string;
  agents: LiveVoiceContextAgent[];
  workspaces: LiveVoiceContextWorkspace[];
  /**
   * Whether the attached session launched with Paseo's MCP tools. When false the
   * model must not offer to act on Paseo — it would promise work the session
   * cannot carry out.
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

const DELEGATION_WITH_PASEO_TOOLS =
  "- To get anything done, delegate to the attached session by saying what needs to happen. It runs on the user's machine with their code, and it also has Paseo's own tools, so it can read and change code, run commands, and control Paseo itself: list, create and archive workspaces; list, create, cancel and prompt other agent sessions; open terminals; manage schedules and heartbeats.";

const DELEGATION_WITHOUT_PASEO_TOOLS =
  "- To get anything done, delegate to the attached session by saying what needs to happen. It runs on the user's machine with their code, so it can read and change code and run commands. It cannot control Paseo itself on this daemon, so do not offer to create, archive, or manage workspaces, sessions, terminals, or schedules.";

export function buildLiveVoicePrompt(paseoToolsAvailable: boolean): string {
  return [
    "You are the voice of Paseo.",
    "",
    "Paseo runs and monitors AI coding agent sessions on the user's own machine. The user is talking to you out loud, hands-free, often away from their keyboard.",
    "",
    "How you work:",
    "- You are attached to one agent session, described below. You are not that session; you are its voice.",
    paseoToolsAvailable ? DELEGATION_WITH_PASEO_TOOLS : DELEGATION_WITHOUT_PASEO_TOOLS,
    "- Delegate anything that touches code, files, or commands. Answer directly only when the answer is already in this conversation or when you need a clarifying question first.",
    "- Replies from the attached session come back to you as text. Narrate them: summarize what happened in a sentence or two instead of reading them out verbatim.",
    "",
    "How to speak:",
    "- Short, plain, spoken sentences. No markdown, no bullet lists, no code blocks, and never spell out long file paths.",
    "- Before delegating something slow, say briefly what you are about to do so the user is not left in silence.",
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
 * Sections in priority order. The attached session matters most (it is what the
 * user is talking about), then the other sessions, then the workspace map.
 */
function buildSections(snapshot: LiveVoiceContextSnapshot): string[] {
  const sections: string[] = [];
  const attached = snapshot.agents.find((agent) => agent.id === snapshot.attachedAgentId);
  if (attached) {
    sections.push(["The agent session you are attached to:", describeAgent(attached)].join("\n"));
  }

  const others = snapshot.agents.filter((agent) => agent.id !== snapshot.attachedAgentId);
  if (others.length > 0) {
    const listed = others.slice(0, MAX_LISTED);
    const omitted = others.length - listed.length;
    sections.push(
      [
        `Other agent sessions on this daemon (${others.length}):`,
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
): LiveVoiceStartContext {
  return {
    prompt: buildLiveVoicePrompt(snapshot.paseoToolsAvailable),
    initialItems: buildLiveVoiceInitialItems(snapshot),
  };
}
