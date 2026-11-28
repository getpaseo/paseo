/**
 * What an agent sender chooses for a recipient with a running turn.
 * queue: wait until the turn ends. steer: enter the running turn. interrupt: replace it.
 */
export type AgentMessageBehavior = "queue" | "steer" | "interrupt";

interface Admission {
  activeTurnBehavior: AgentMessageBehavior;
  /** The recipient has a turn running or starting. */
  running: boolean;
  /** The recipient's provider can take a message into a running turn. */
  canSteer: boolean;
}

const DO_NOT_REPEAT =
  "The follow-up carries this message ahead of it, so do not send this message again.";

/**
 * Tells the sender, at admission, what happens to its message and how to change it. Built from
 * facts known now, not from the outcome: a provider that can steer may still refuse one steer.
 */
export function describeAgentMessage(admission: Admission): string {
  const { activeTurnBehavior, running, canSteer } = admission;
  if (activeTurnBehavior === "queue") {
    if (!running)
      return "Queued. The agent is idle, so your message starts a turn in about 2 seconds.";
    const waiting =
      "Queued, not delivered yet. The agent is working and reads your message when its current turn ends.";
    const followUp = canSteer
      ? 'If the message cannot wait, send a short follow-up with activeTurnBehavior "steer" (it joins the running turn) or "interrupt" (it stops the turn and starts a new one).'
      : 'If the message cannot wait, send a short follow-up with activeTurnBehavior "interrupt" (it stops the turn and starts a new one). This agent\'s provider cannot steer, so "steer" also stops the turn.';
    return `${waiting} ${followUp} ${DO_NOT_REPEAT}`;
  }
  if (!running) return "The agent is idle, so your message starts a turn now.";
  if (activeTurnBehavior === "interrupt")
    return "Interrupting the running turn. A new turn starts with your message.";
  return canSteer
    ? "Steering the running turn. The agent reads your message at its next step and keeps working."
    : "This agent's provider cannot steer, so your message interrupts the running turn. A new turn starts with your message.";
}
