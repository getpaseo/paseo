export function formatCaughtValue(value: unknown): string {
  try {
    return formatCaughtValueWithSeenErrors(value, new WeakSet<Error>());
  } catch (formattingError) {
    return formatFormattingFailure(value, formattingError);
  }
}

function formatCaughtValueWithSeenErrors(value: unknown, seenErrors: WeakSet<Error>): string {
  if (value instanceof Error) {
    return formatError(value, seenErrors);
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

  return stringifyJson(value, seenErrors) ?? safeString(value);
}

function formatError(error: Error, seenErrors: WeakSet<Error>): string {
  if (seenErrors.has(error)) {
    return "[Circular Error]";
  }

  seenErrors.add(error);
  const sections: string[] = [];
  const name = formatErrorTextProperty(Reflect.get(error, "name"), seenErrors);
  const message = formatErrorTextProperty(Reflect.get(error, "message"), seenErrors);
  const stack = formatErrorTextProperty(Reflect.get(error, "stack"), seenErrors);

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
    sections.push(`Cause:\n${formatCaughtValueWithSeenErrors(errorCause.value, seenErrors)}`);
  }

  const aggregateErrors = getAggregateErrors(error);
  if (aggregateErrors.hasErrors) {
    sections.push(`Errors:\n${formatCaughtValueWithSeenErrors(aggregateErrors.value, seenErrors)}`);
  }

  const fields = getErrorFields(error);
  if (fields !== null) {
    sections.push(`Fields:\n${stringifyJson(fields, seenErrors) ?? safeString(fields)}`);
  }

  seenErrors.delete(error);
  return sections.join("\n\n") || safeString(error);
}

function formatErrorTextProperty(value: unknown, seenErrors: WeakSet<Error>): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (value === undefined) {
    return null;
  }
  return stringifyJson(value, seenErrors) ?? safeString(value);
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

function stringifyJson(value: unknown, seenErrors: WeakSet<Error>): string | null {
  const seen = new WeakSet<object>();
  try {
    const serialized = JSON.stringify(
      value,
      (_key, nestedValue: unknown) => {
        if (nestedValue instanceof Error) {
          return formatError(nestedValue, seenErrors);
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

function formatFormattingFailure(value: unknown, formattingError: unknown): string {
  const valueText = safeString(value);
  const formattingErrorText = safeString(formattingError);
  if (formattingErrorText === "[Unserializable value]") {
    return valueText;
  }
  return `${valueText}\n\nDetails unavailable:\n${formattingErrorText}`;
}
