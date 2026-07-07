export function formatCaughtValue(value: unknown): string {
  if (value instanceof Error) {
    return formatError(value);
  }

  if (typeof value === "string") {
    return value;
  }

  if (value === null || value === undefined) {
    return safeString(value);
  }

  if (typeof value !== "object" && typeof value !== "function") {
    return safeString(value);
  }

  return stringifyJson(value) ?? safeString(value);
}

function formatError(error: Error): string {
  const sections: string[] = [];
  const name = formatErrorTextProperty(Reflect.get(error, "name"));
  const message = formatErrorTextProperty(Reflect.get(error, "message"));
  const stack = formatErrorTextProperty(Reflect.get(error, "stack"));

  if (name) {
    sections.push(`Name: ${name}`);
  }
  if (message) {
    sections.push(`Message: ${message}`);
  }
  if (stack) {
    sections.push(`Stack:\n${stack}`);
  }

  const errorCause = getErrorCause(error);
  if (errorCause.hasCause) {
    sections.push(`Cause:\n${formatCaughtValue(errorCause.value)}`);
  }

  const aggregateErrors = getAggregateErrors(error);
  if (aggregateErrors.hasErrors) {
    sections.push(`Errors:\n${formatCaughtValue(aggregateErrors.value)}`);
  }

  const fields = getErrorFields(error);
  if (fields !== null) {
    sections.push(`Fields:\n${stringifyJson(fields) ?? safeString(fields)}`);
  }

  return sections.join("\n\n") || safeString(error);
}

function formatErrorTextProperty(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (value === undefined) {
    return null;
  }
  return stringifyJson(value) ?? safeString(value);
}

function getErrorCause(error: Error): { hasCause: boolean; value: unknown } {
  if (!Reflect.has(error, "cause")) {
    return { hasCause: false, value: null };
  }
  return { hasCause: true, value: Reflect.get(error, "cause") };
}

function getAggregateErrors(error: Error): { hasErrors: boolean; value: unknown } {
  if (!Reflect.has(error, "errors")) {
    return { hasErrors: false, value: null };
  }
  return { hasErrors: true, value: Reflect.get(error, "errors") };
}

function getErrorFields(error: Error): Record<string, unknown> | null {
  const fields: Record<string, unknown> = {};
  for (const key of Object.keys(error)) {
    if (
      key === "name" ||
      key === "message" ||
      key === "stack" ||
      key === "cause" ||
      key === "errors"
    ) {
      continue;
    }
    fields[key] = Reflect.get(error, key);
  }

  return Object.keys(fields).length > 0 ? fields : null;
}

function stringifyJson(value: unknown): string | null {
  const seen = new WeakSet<object>();
  try {
    const serialized = JSON.stringify(
      value,
      (_key, nestedValue: unknown) => {
        if (nestedValue instanceof Error) {
          return formatError(nestedValue);
        }
        if (typeof nestedValue === "bigint") {
          return String(nestedValue);
        }
        if (nestedValue !== null && typeof nestedValue === "object") {
          if (seen.has(nestedValue)) {
            return "[Circular]";
          }
          seen.add(nestedValue);
        }
        return nestedValue;
      },
      2,
    );
    return typeof serialized === "string" ? serialized : null;
  } catch {
    return null;
  }
}

function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "[Unserializable value]";
  }
}
