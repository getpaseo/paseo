/**
 * Extracts a human-readable error message from an unknown error value.
 * Handles Error instances, string errors, and thrown objects that would
 * otherwise stringify as "[object Object]".
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (error === null || error === undefined) {
    return String(error);
  }
  return stringifyUnknownError(error);
}

/**
 * Extracts an error message from an unknown error value, with a fallback
 * for when no message can be extracted.
 */
export function getErrorMessageOr(error: unknown, fallback: string): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string" && error.length > 0) {
    return error;
  }
  if (typeof error === "string" || error === null || error === undefined) {
    return fallback;
  }
  const message = stringifyUnknownError(error);
  if (message.length === 0 || message === "Unknown error") {
    return fallback;
  }
  return message;
}

function stringifyUnknownError(error: unknown): string {
  try {
    const serialized = JSON.stringify(error);
    if (serialized && serialized !== "{}" && serialized !== '""') {
      return serialized;
    }
  } catch {
    // circular refs, bigint, etc.
  }

  const stringified = String(error);
  if (stringified.length > 0 && stringified !== "[object Object]") {
    return stringified;
  }
  return "Unknown error";
}
