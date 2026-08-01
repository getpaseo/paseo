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
  const provenance = notification.unsolicited ? "which you did not start" : "which you started";
  const lines = [`The agent session "${notification.title}"${where}, ${provenance}, ${outcome}.`];
  if (notification.summary) {
    lines.push("", "What it reported:", notification.summary);
  }
  lines.push("", speakingInstruction(notification));
  lines.push(
    "Do not read this note back, do not spell out the session id, and do not repeat the report verbatim.",
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
