/**
 * Claude Agent SDK `forkSession({ upToMessageId })` requires a transcript JSONL
 * message UUID. Live Paseo timelines often store the Anthropic API message id
 * (`msg_…`) on assistant rows instead. Map those (and other aliases) back to a
 * transcript UUID before calling the SDK.
 */

export interface ClaudeTranscriptMessageLookup {
  uuid: string;
  apiMessageId?: string | null;
}

export function resolveClaudeTranscriptMessageId(input: {
  candidate: string;
  apiMessageIdToTranscriptUuid?: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
  knownTranscriptUuids?: ReadonlySet<string> | readonly string[];
  sessionMessages?: readonly ClaudeTranscriptMessageLookup[];
}): string {
  const candidate = input.candidate.trim();
  if (!candidate) {
    throw new Error("Native fork requires a boundary message id");
  }

  const mapped = lookupMap(input.apiMessageIdToTranscriptUuid, candidate);
  if (mapped) {
    return mapped;
  }

  const known = toStringSet(input.knownTranscriptUuids);
  for (const message of input.sessionMessages ?? []) {
    if (message.uuid) {
      known.add(message.uuid);
    }
  }
  if (known.has(candidate)) {
    return candidate;
  }

  for (const message of input.sessionMessages ?? []) {
    const apiMessageId = message.apiMessageId?.trim();
    if (apiMessageId && apiMessageId === candidate && message.uuid.trim()) {
      return message.uuid.trim();
    }
  }

  if (looksLikeAnthropicApiMessageId(candidate)) {
    throw new Error(
      `Invalid upToMessageId: ${candidate} (API message id is not a transcript UUID and could not be mapped)`,
    );
  }

  // Unknown non-API ids: pass through so the SDK can validate against the transcript.
  return candidate;
}

export function readApiMessageIdFromContainer(message: unknown): string | null {
  const container = toObjectRecord(message);
  if (!container) {
    return null;
  }
  const id = container.id;
  if (typeof id === "string" && id.trim().length > 0) {
    return id.trim();
  }
  const messageId = container.message_id;
  if (typeof messageId === "string" && messageId.trim().length > 0) {
    return messageId.trim();
  }
  return null;
}

export function looksLikeAnthropicApiMessageId(value: string): boolean {
  return value.startsWith("msg_");
}

function lookupMap(
  source: ReadonlyMap<string, string> | Readonly<Record<string, string>> | undefined,
  key: string,
): string | null {
  if (!source) {
    return null;
  }
  if (isReadonlyMap(source)) {
    const value = source.get(key);
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  }
  const value = (source as Readonly<Record<string, string>>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function toStringSet(source: ReadonlySet<string> | readonly string[] | undefined): Set<string> {
  if (!source) {
    return new Set();
  }
  if (source instanceof Set) {
    return new Set(source);
  }
  const values = source as readonly string[];
  return new Set(values.filter((value) => typeof value === "string" && value.length > 0));
}

function isReadonlyMap(value: unknown): value is ReadonlyMap<string, string> {
  return value instanceof Map;
}

function toObjectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
