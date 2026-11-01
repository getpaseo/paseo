/** Minimal shape of a normalized provider error, as produced by each adapter. */
export interface ProviderErrorSummary {
  message?: string;
  code?: string;
}

// JSON-RPC's generic internal error. Providers that refuse a prompt because an
// earlier turn was never released report it this way, so the code alone says
// nothing and the message is the only signal that the session is still usable.
const JSON_RPC_INTERNAL_ERROR = "-32603";
const BUSY_TURN_PATTERN = /already has an active turn/i;

export function isProviderBusyTurnError(error: ProviderErrorSummary | null | undefined): boolean {
  if (!error || error.code !== JSON_RPC_INTERNAL_ERROR) return false;
  return typeof error.message === "string" && BUSY_TURN_PATTERN.test(error.message);
}

/**
 * Structural shape of the terminal turn_failed event a caller sees, so this
 * module never needs the full stream-event union.
 */
export interface TerminalTurnFailureEvent {
  type: string;
  error: string;
  code?: string;
}

export function isRecoveredBusyTurnFailure(event: TerminalTurnFailureEvent): boolean {
  return (
    event.type === "turn_failed" &&
    isProviderBusyTurnError({ code: event.code, message: event.error })
  );
}
