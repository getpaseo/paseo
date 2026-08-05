import type { VoiceLiveAgentNotification } from "@getpaseo/protocol/live-voice-routing";

import { normalizeWorkspaceName } from "./live-voice-workspace-search.js";

/**
 * Turns a work notification into the developer item appended to a running call.
 *
 * The item is an instruction, not a line to read out: the model is mid-call and
 * has to decide when to say this and how much of it matters. Left as a bare
 * status line it either gets read verbatim, ids and all, or sits unspoken until
 * the user happens to talk again.
 */
export function formatLiveVoiceAgentNotification(notification: VoiceLiveAgentNotification): string {
  const where = notification.hostLabel ? ` on ${notification.hostLabel}` : "";
  const outcome = describeReason(notification.reason);
  const lines = [
    `The "${notification.title}" agent${describePlacement(notification)}${where} ${outcome}.`,
  ];
  if (notification.summary) {
    lines.push("", "What it reported:", notification.summary);
  }
  lines.push("", speakingInstruction(notification));
  lines.push(PLACEMENT_INSTRUCTION);
  lines.push(
    "Do not read this note back, do not spell out the agent id, and do not repeat the report verbatim.",
  );
  if (notification.reason === "needs_permission") {
    lines.push(
      notification.unsolicited
        ? "It stays blocked until someone answers, which makes it more worth raising than a session that merely finished."
        : "It is blocked until someone answers, so say what it is asking for and offer to answer it.",
    );
  }
  return lines.join("\n");
}

/**
 * Work the call started was asked for, so the user is owed the answer. Ambient
 * reports were not asked for and arrive whenever the machine happens to finish
 * something, so interrupting is a judgement call — and saying nothing has to be
 * one of the outcomes, or a busy machine turns the call into a stream of
 * announcements nobody can talk over.
 */
function speakingInstruction(notification: VoiceLiveAgentNotification): string {
  if (!notification.unsolicited) {
    return "Tell the user now, out loud, in one or two spoken sentences.";
  }
  return "Decide whether this is worth interrupting for. If it is, say it in one or two spoken sentences, and wait for a natural gap rather than talking over the user. If it is not, say nothing at all and do not acknowledge this note — silence is a valid response, and several of these arriving together is a reason to say less, not more.";
}

/**
 * Which piece of work this was, before what happened to it.
 *
 * The user is away from the keyboard and may have several agents running on
 * several machines. "It finished" identifies none of them. Which name places it
 * is a judgement the model is better placed to make than this note is: the
 * agent's title, the workspace, the project, or a phrase off what it reported,
 * depending on what the user was last talking about.
 */
const PLACEMENT_INSTRUCTION =
  "Say which work this was before what happened to it. Judge a short phrase for it from the agent, workspace and project names — often the project alone is clear enough — and skip any name that adds nothing, including the machine unless the user has work on several. Never lead with the last message.";

/**
 * Where the work lives, with names that repeat each other dropped.
 *
 * A workspace usually holds one agent and is often named after its project, so
 * spelling out all three reads as a stutter — "the Refresh Paseo assembly agent
 * in the Refresh Paseo assembly workspace of the Paseo project". Each name is
 * kept only if it adds something the ones before it did not.
 */
function describePlacement(notification: VoiceLiveAgentNotification): string {
  const workspace = repeatsName(notification.title, notification.workspaceName)
    ? null
    : (notification.workspaceName ?? null);
  const project =
    repeatsName(notification.title, notification.projectName) ||
    repeatsName(workspace, notification.projectName)
      ? null
      : (notification.projectName ?? null);
  const parts: string[] = [];
  if (workspace) {
    parts.push(` in the ${workspace} workspace`);
  }
  if (project) {
    parts.push(`${workspace ? " of" : " in"} the ${project} project`);
  }
  return parts.join("");
}

/**
 * Whether two names are the same handle on the same work. Both have been through
 * a user's typing and, for a workspace, a directory name, so they match on words
 * rather than characters. A single shared word is not enough — every title in a
 * "paseo" workspace contains "paseo".
 */
function repeatsName(name: string | null | undefined, other: string | null | undefined): boolean {
  if (!name || !other) {
    return false;
  }
  const a = normalizeWorkspaceName(name);
  const b = normalizeWorkspaceName(other);
  if (!a || !b) {
    return false;
  }
  if (a === b) {
    return true;
  }
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter.split(" ").length < 2) {
    return false;
  }
  return ` ${longer} `.includes(` ${shorter} `);
}

function describeReason(reason: string): string {
  switch (reason) {
    case "turn_completed":
    case "finished":
      return "completed its current turn";
    case "errored":
      return "stopped with an error";
    case "authentication_required":
      return "stopped because the provider requires sign-in";
    case "needs_permission":
      return "is waiting for permission to continue";
    default:
      // A newer daemon can report outcomes this one has never heard of; pass the
      // raw reason through rather than inventing one.
      return reason;
  }
}
