import type { VoiceLiveAgentNotification } from "@getpaseo/protocol/live-voice-routing";

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
    `The agent session "${notification.title}"${where}, which you started, ${outcome}.`,
  ];
  if (notification.summary) {
    lines.push("", "What it reported:", notification.summary);
  }
  lines.push(
    "",
    "Tell the user now, out loud, in one or two spoken sentences. Do not read this note back, do not spell out the session id, and do not repeat the report verbatim.",
  );
  if (notification.reason === "needs_permission") {
    lines.push(
      "It is blocked until someone answers, so say what it is asking for and offer to answer it.",
    );
  }
  return lines.join("\n");
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
