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
  const serialized = serializeUnknownErrorJson(error);
  if (serialized) {
    return serialized;
  }

  const coerced = coerceUnknownErrorToString(error);
  if (coerced.length > 0 && coerced !== "[object Object]") {
    return coerced;
  }
  return "Unknown error";
}

function serializeUnknownErrorJson(error: unknown): string | null {
  try {
    const serialized = JSON.stringify(error);
    if (serialized && serialized !== "{}" && serialized !== '""') {
      return serialized;
    }
    return null;
  } catch (serializationError) {
    // Cycles and throwing toJSON fail here; try String() next regardless of throw shape.
    void serializationError;
    return null;
  }
}

function coerceUnknownErrorToString(error: unknown): string {
  try {
    return String(error);
  } catch (coercionError) {
    if (coercionError instanceof Error && coercionError.message.trim().length > 0) {
      return `Unknown error (${coercionError.message})`;
    }
    if (typeof coercionError === "string" && coercionError.trim().length > 0) {
      return `Unknown error (${coercionError})`;
    }
    return "Unknown error";
  }
}
