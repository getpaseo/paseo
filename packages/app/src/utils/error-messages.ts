const FALLBACK_ERROR_MESSAGE = "Unknown error";

function getStringProperty(error: object, key: "message" | "error"): string | null {
  const value = Reflect.get(error, key);
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  if (typeof error === "object" && error !== null) {
    return (
      getStringProperty(error, "message") ??
      getStringProperty(error, "error") ??
      FALLBACK_ERROR_MESSAGE
    );
  }

  return FALLBACK_ERROR_MESSAGE;
}
