import type { AgentStreamEvent } from "../agent-sdk-types.js";

/** A native start event can precede the prompt RPC's reply (which some runtimes delay until completion). */
export async function waitForProviderPromptAdmission(input: {
  turnId: string;
  subscribe: (callback: (event: AgentStreamEvent) => void) => () => void;
  submit: (accepted: () => void) => Promise<void>;
}): Promise<void> {
  let accepted!: () => void;
  const started = new Promise<void>((resolve) => {
    accepted = resolve;
  });
  const unsubscribe = input.subscribe((event) => {
    if (event.type === "turn_started" && event.turnId === input.turnId) accepted();
  });
  try {
    await Promise.race([input.submit(accepted), started]);
  } finally {
    unsubscribe();
  }
}

export function promptSubmissionError(error: unknown, submitted: boolean): Error {
  return Object.assign(error instanceof Error ? error : new Error(String(error)), {
    deliveryOutcome: submitted ? "unknown" : "not_submitted",
  });
}
