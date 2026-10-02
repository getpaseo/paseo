export const MAX_PROVIDER_ATTEMPTS = 3;

/**
 * What a provider says when a turn dies, in a form the rest of the daemon can act on.
 *
 * Providers hand us their failure as a string, and some hand us their whole error object
 * serialized into it — `{"name":"APIError","data":{"message":"Our servers are currently
 * overloaded.","statusCode":503,"isRetryable":true,…}}`. That blob went straight into the
 * timeline, so a run that died of a passing upstream hiccup read as a wall of JSON, and the
 * `isRetryable` the provider itself set was never looked at by anyone.
 */
export interface ProviderFailure {
  /** The sentence to show a person. Never the raw blob. */
  message: string;
  statusCode?: number;
  /** Whether trying the same thing again has a real chance of working. */
  retryable: boolean;
}

/** Status codes that mean "the other side is busy", not "your request is wrong". */
const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Last resort when there is no status code and no flag: providers say these in prose. */
const RETRYABLE_PHRASES = [
  "overloaded",
  "rate limit",
  "temporarily unavailable",
  "try again later",
  "timed out",
  "timeout",
  "econnreset",
  "socket hang up",
];

export function describeProviderFailure(raw: string, code?: string): ProviderFailure {
  const trimmed = raw.trim();
  const parsed = parseErrorBlob(trimmed);
  const message = buildMessage(parsed, trimmed, code);
  const statusCode = parsed?.statusCode;
  return {
    message,
    ...(statusCode === undefined ? {} : { statusCode }),
    retryable:
      !["quota_fallback_exhausted", "provider_retry_exhausted"].includes(code ?? "") &&
      decideRetryable(parsed, trimmed),
  };
}

interface ParsedBlob {
  name?: string;
  message?: string;
  statusCode?: number;
  isRetryable?: boolean;
}

function parseErrorBlob(raw: string): ParsedBlob | null {
  if (!raw.startsWith("{")) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const root = value as Record<string, unknown>;
  const data = typeof root.data === "object" && root.data !== null ? root.data : root;
  const bag = data as Record<string, unknown>;
  const parsed: ParsedBlob = {};
  if (typeof root.name === "string") parsed.name = root.name;
  const message = bag.message ?? root.message;
  if (typeof message === "string") parsed.message = message;
  const statusCode = bag.statusCode ?? bag.status ?? root.statusCode;
  if (typeof statusCode === "number") parsed.statusCode = statusCode;
  const isRetryable = bag.isRetryable ?? root.isRetryable;
  if (typeof isRetryable === "boolean") parsed.isRetryable = isRetryable;
  return parsed;
}

function buildMessage(parsed: ParsedBlob | null, raw: string, code?: string): string {
  const base = parsed?.message?.trim() || (parsed === null ? raw : "") || "Provider run failed";
  const suffixes: string[] = [];
  if (parsed?.statusCode !== undefined) {
    suffixes.push(`HTTP ${parsed.statusCode}`);
  }
  const trimmedCode = code?.trim();
  if (trimmedCode) {
    suffixes.push(trimmedCode);
  }
  return suffixes.length > 0 ? `${base} (${suffixes.join(", ")})` : base;
}

function decideRetryable(parsed: ParsedBlob | null, raw: string): boolean {
  // The provider's own verdict wins: it knows whether its request was accepted.
  if (parsed?.isRetryable !== undefined) {
    return parsed.isRetryable;
  }
  if (parsed?.statusCode !== undefined) {
    return RETRYABLE_STATUS_CODES.has(parsed.statusCode);
  }
  const haystack = (parsed?.message ?? raw).toLowerCase();
  return RETRYABLE_PHRASES.some((phrase) => haystack.includes(phrase));
}

export interface RetryDecisionInput {
  failure: ProviderFailure;
  /** Attempts already spent on this turn, including the one that just failed. */
  attempt: number;
  maxAttempts: number;
  /**
   * Whether this turn already ran a tool. A retry re-sends the same prompt, so a turn that has
   * already written to the working tree must not be replayed behind the user's back — the
   * failure stands and they decide.
   */
  producedSideEffects: boolean;
}

export function shouldRetryProviderFailure(input: RetryDecisionInput): boolean {
  if (!input.failure.retryable) return false;
  if (input.producedSideEffects) return false;
  return input.attempt < input.maxAttempts;
}

/** Exponential with a floor and a ceiling, so a busy provider is not hammered. */
export function providerRetryDelayMs(attempt: number): number {
  const base = 1000 * 2 ** Math.max(0, attempt - 1);
  return Math.min(base, 15000);
}

export function isModelCapacityError(input: {
  message?: string;
  diagnostic?: string;
  code?: string;
}): boolean {
  return [input.message, input.diagnostic, input.code].some(
    (value) =>
      typeof value === "string" &&
      /selected model is at capacity|model[_ -]at[_ -]capacity/i.test(value),
  );
}
