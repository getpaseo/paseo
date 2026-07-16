import { formatSystemNotificationPrompt } from "./agent-prompt.js";
import type { AgentPromptInput } from "./agent-sdk-types.js";

/**
 * Deterministic, daemon-composed text that teaches every Paseo-managed agent
 * about the multi-agent environment it runs in. Two surfaces consume this:
 *
 * - Layer 1 (`composeAgentMcpInstructions`) is handed to the per-agent MCP
 *   server as its `instructions` string. Providers that surface MCP server
 *   instructions in their system prompt (Claude Code) make the agent "born
 *   knowing" the contract with zero per-spawn prompt discipline.
 * - Layer 2 (`buildSpawnContextEnvelope`) is prepended to the child's initial
 *   prompt as a `<paseo-system>` block, guaranteeing the identity/report
 *   contract reaches agents on providers that do NOT surface MCP instructions.
 */

export interface AgentMcpInstructionsInput {
  /** The agent that owns this MCP session (the connecting agent itself). */
  callerAgentId?: string;
  /** Parent linkage read from the caller's `paseo.parent-agent-id` label. */
  parentAgentId?: string | null;
  /** Human-facing title of the parent agent, when resolvable. */
  parentTitle?: string | null;
}

function describeAgent(agentId: string, title: string | null | undefined): string {
  const trimmedTitle = title?.trim();
  return trimmedTitle ? `${agentId} (${trimmedTitle})` : agentId;
}

const DELEGATION_CONTRACT = [
  "When you spawn children with create_agent: capture the returned agentId, leave notifyOnFinish at its default so their reports come back to you, and do NOT poll for status - the daemon notifies you when a child finishes, errors, or needs permission.",
  "Use send_agent_prompt to follow up with a child, and list_pending_permissions plus respond_to_permission to unblock a child waiting on approval - a blocked child stays blocked until you answer.",
].join(" ");

const ENVELOPE_SEMANTICS =
  'Messages wrapped in <paseo-system>...</paseo-system> are daemon-injected context (schedules, finish notifications), not user turns. A finish notification from a child you spawned carries that child\'s report inside <agent-response>...</agent-response>. A turn wrapped in <paseo-agent-message from="..." from_title="...">...</paseo-agent-message> was sent to you by another agent: read the from id, respond promptly, and reply via send_agent_prompt to that id - or, when the envelope says your reply is auto-delivered, simply make your final message a complete, self-contained reply.';

const NO_COPY_NOTE =
  "The daemon automatically gives every spawned agent this same context - you do NOT need to copy any protocol block into a child's initialPrompt.";

/**
 * Compose the MCP `instructions` string for a connecting agent. Compact by
 * design (well under ~600 words): it lands verbatim in the agent's system
 * prompt on providers that surface MCP instructions.
 */
export function composeAgentMcpInstructions(input: AgentMcpInstructionsInput): string {
  const paragraphs: string[] = [];

  if (input.callerAgentId) {
    paragraphs.push(
      `You are running inside Paseo, a multi-agent environment where AI coding agents spawn, message, and supervise each other. Your agentId is ${input.callerAgentId}.`,
    );
    if (input.parentAgentId) {
      paragraphs.push(
        `You were spawned by agent ${describeAgent(input.parentAgentId, input.parentTitle)}. When you go idle, your last assistant message is AUTOMATICALLY delivered to that agent as your report. Make your final message a complete, self-contained report - the task, what you did, key findings, files changed, what failed or is uncertain, and the recommended next step. Do not end with a bare sign-off like "Done"; end with the report itself, and do not poll the parent for acknowledgement.`,
      );
    }
  } else {
    paragraphs.push(
      "You are connected to Paseo, a multi-agent environment where AI coding agents spawn, message, and supervise each other through these tools.",
    );
  }

  paragraphs.push(ENVELOPE_SEMANTICS, DELEGATION_CONTRACT, NO_COPY_NOTE);
  return paragraphs.join("\n\n");
}

export interface SpawnContextInput {
  childAgentId: string;
  parentAgentId: string;
  parentTitle?: string | null;
  /**
   * True when the daemon will auto-deliver the child's final message to the
   * parent (create-agent's notifyOnFinish). Detached spawns can still set it;
   * the report promise follows notifyOnFinish, not the relationship kind.
   */
  notifyOnFinish: boolean;
}

/**
 * Build the short `<paseo-system>` block prepended to a child's initial prompt.
 * Duplicates only the identity + report-contract core of the MCP instructions
 * so agents on providers that already surface those instructions are not
 * bloated with a second full copy.
 */
export function buildSpawnContextEnvelope(input: SpawnContextInput): string {
  const identity = `You are agent ${input.childAgentId}, spawned by agent ${describeAgent(
    input.parentAgentId,
    input.parentTitle,
  )} inside Paseo's multi-agent environment.`;
  const contract = input.notifyOnFinish
    ? `When you finish and go idle, your last assistant message is automatically delivered to agent ${input.parentAgentId} as your report. Make your final message a complete, self-contained report of the task, what you did, files changed, failures or uncertainties, and recommended next steps - never a bare sign-off.`
    : `Your final message is not automatically delivered back; agent ${input.parentAgentId} follows up if it needs your result. Still, make your final message a complete, self-contained summary of what you did.`;
  return formatSystemNotificationPrompt(`${identity} ${contract}`);
}

/**
 * Prepend a spawn-context envelope to a child's initial prompt. The envelope is
 * a self-contained `<paseo-system>` block, so the timeline layer strips it from
 * the visible first user message (see displayTextForUserMessage) while the
 * provider still receives it in full.
 */
export function prependSpawnContext(prompt: AgentPromptInput, envelope: string): AgentPromptInput {
  if (typeof prompt === "string") {
    return `${envelope}\n\n${prompt}`;
  }
  return [{ type: "text", text: `${envelope}\n\n` }, ...prompt];
}

// --- Agent-to-agent sender envelope ---------------------------------------
//
// When one agent sends a prompt to another via send_agent_prompt, the receiver
// used to get the text verbatim with no way to tell it came from an agent or
// whom to reply to. buildAgentMessageEnvelope wraps the prompt in an attributed
// <paseo-agent-message> tag carrying the sender's identity plus a reply
// contract. The tag is deliberately NOT a <paseo-system> envelope: it must not
// match SYSTEM_ENVELOPE_PATTERN (which would hide it from the timeline and can
// gate archived-target delivery), and sender attribution is useful for a human
// reading the receiver's timeline, so it is projected to a readable header
// rather than stripped.

const AGENT_MESSAGE_TAG = "paseo-agent-message";

// Attribute values (the sender title) may contain arbitrary characters. Escape
// the five XML-significant ones so `from_title="..."` parses unambiguously and
// no title can break out of the tag.
function escapeAttributeValue(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function unescapeAttributeValue(value: string): string {
  return value
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

export interface AgentMessageEnvelopeInput {
  senderAgentId: string;
  senderTitle?: string | null;
  prompt: string;
  /**
   * True when the daemon will auto-relay the receiver's final message back to
   * the sender (send_agent_prompt's notify-on-finish path). Drives the reply
   * contract wording, mirroring the spawn-context notifyOnFinish gate.
   */
  autoReply: boolean;
}

/**
 * Wrap a sender's prompt in an attributed <paseo-agent-message> tag. The tag
 * wraps only the original prompt; the reply contract rides as a trailing
 * model-only line that the timeline projection drops for display.
 */
export function buildAgentMessageEnvelope(input: AgentMessageEnvelopeInput): string {
  const trimmedTitle = input.senderTitle?.trim();
  const titleAttribute = trimmedTitle ? ` from_title="${escapeAttributeValue(trimmedTitle)}"` : "";
  const replyContract = input.autoReply
    ? `When you finish this turn and go idle, your last assistant message is automatically delivered back to agent ${input.senderAgentId} as your reply - make it complete and self-contained.`
    : `Your reply is not automatically delivered; reach the sender via send_agent_prompt with agentId ${input.senderAgentId} if a response is needed.`;
  return `<${AGENT_MESSAGE_TAG} from="${input.senderAgentId}"${titleAttribute}>\n${input.prompt}\n</${AGENT_MESSAGE_TAG}>\n\n${replyContract}`;
}

// Matches a leading <paseo-agent-message ...> block (the tag wraps the original
// prompt; anything after the close tag is model-only reply boilerplate).
const AGENT_MESSAGE_PATTERN = new RegExp(
  `^<${AGENT_MESSAGE_TAG} ([^>]*)>\\n([\\s\\S]*?)\\n</${AGENT_MESSAGE_TAG}>`,
);

function parseAttribute(attributes: string, name: string): string | null {
  const match = new RegExp(`${name}="([^"]*)"`).exec(attributes);
  return match ? unescapeAttributeValue(match[1]) : null;
}

/**
 * Project a received agent-to-agent message to a compact, human-readable form
 * for the receiver's timeline: a `Message from agent <id> (<title>):` header
 * followed by the original prompt. Non-agent-message text is returned
 * unchanged. Runs daemon-side so every client (including old ones) sees the
 * readable form.
 */
export function projectAgentMessageForDisplay(text: string): string {
  const match = AGENT_MESSAGE_PATTERN.exec(text);
  if (!match) {
    return text;
  }
  const senderAgentId = parseAttribute(match[1], "from");
  if (!senderAgentId) {
    return text;
  }
  const senderTitle = parseAttribute(match[1], "from_title");
  const header = `Message from agent ${describeAgent(senderAgentId, senderTitle)}:`;
  return `${header}\n\n${match[2]}`;
}
