/**
 * Detects the provider-side "this session no longer exists" failure class.
 *
 * Some ACP agents bind each session to an in-process runtime (e.g. Kimi's
 * engine registers `acp:<sessionId>` in its workspace runtime registry). When
 * that binding is lost while the client still holds the session, every prompt
 * fails with a runtime/session error until the provider process is replaced
 * and the session is re-loaded from persistence — which re-registers what was
 * dropped. Paseo recovers automatically; these signatures decide when.
 *
 * The matcher also runs on assistant message text, because some providers
 * deliver the failed turn in-band (the prompt resolves `end_turn` and the
 * error arrives as an `agent_message_chunk`). Keep the patterns tight: a
 * loose match would misclassify a model quoting or discussing the error.
 */

const SESSION_INVALID_PATTERNS: readonly RegExp[] = [
  /\bruntime\.not_found\b/,
  /\bruntime \S+ does not exist in workspace \S+/,
  /\bruntime binding workspace \S+ does not match session workspace \S+/,
  /\bworkspace \S+ is not materialized\b/,
  /\bUnknown sessionId\b/i,
  /\bsession \S+ is not live\b/,
  /\bsession_not_found\b/i,
];

export function isACPProviderSessionInvalidText(text: string): boolean {
  if (!text) {
    return false;
  }
  return SESSION_INVALID_PATTERNS.some((pattern) => pattern.test(text));
}

export function isACPProviderSessionInvalidError(error: unknown): boolean {
  return extractErrorMessages(error).some((message) => isACPProviderSessionInvalidText(message));
}

// ACP rejections arrive both as Error instances and as raw JSON-RPC error
// objects ({ code, message, data }) — the SDK rejects with the latter. The
// generic top-level message often hides the specific text in `data`, so
// every candidate string is matched.
function extractErrorMessages(error: unknown): string[] {
  if (error instanceof Error) {
    return [error.message];
  }
  if (typeof error !== "object" || error === null) {
    return [];
  }
  const record = error as Record<string, unknown>;
  const messages: string[] = [];
  if (typeof record.message === "string") {
    messages.push(record.message);
  }
  const data = record.data;
  if (typeof data === "object" && data !== null) {
    const dataRecord = data as Record<string, unknown>;
    for (const key of ["message", "details"] as const) {
      if (typeof dataRecord[key] === "string") {
        messages.push(dataRecord[key] as string);
      }
    }
  }
  return messages;
}
