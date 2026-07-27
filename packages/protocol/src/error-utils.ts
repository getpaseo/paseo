/**
 * Extracts a human-readable error message from an unknown error value.
 * Handles Error instances, strings, and ACP-style plain objects with
 * `message` / nested `data.message` without collapsing to "[object Object]".
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }

  const fromObject = readObjectErrorMessage(error);
  if (fromObject) {
    return fromObject;
  }

  const stringified = String(error);
  return stringified === "[object Object]" ? "Unknown error" : stringified;
}

/**
 * Extracts an error message from an unknown error value, with a fallback
 * for when no message can be extracted.
 */
export function getErrorMessageOr(error: unknown, fallback: string): string {
  if (error instanceof Error) {
    return error.message.length > 0 ? error.message : fallback;
  }
  if (typeof error === "string" && error.length > 0) {
    return error;
  }
  const fromObject = readObjectErrorMessage(error);
  if (fromObject) {
    return fromObject;
  }
  return fallback;
}

function readObjectErrorMessage(error: unknown): string | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }

  const record = error as Record<string, unknown>;
  const message = readNonEmptyString(record.message);
  const dataMessage = extractNestedDataMessage(record.data);
  if (message && dataMessage && dataMessage !== message) {
    return `${message}: ${dataMessage}`;
  }
  if (message) {
    return message;
  }
  if (dataMessage) {
    return dataMessage;
  }

  try {
    const serialized = JSON.stringify(error);
    if (serialized && serialized !== "{}" && serialized !== "null") {
      return serialized;
    }
  } catch {
    // fall through
  }
  return null;
}

function extractNestedDataMessage(data: unknown): string | null {
  if (typeof data === "string") {
    return readNonEmptyString(data);
  }
  if (typeof data !== "object" || data === null) {
    return null;
  }
  return readNonEmptyString((data as Record<string, unknown>).message);
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
