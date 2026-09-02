/**
 * JSON renderer for CLI output.
 *
 * Renders structured data as formatted JSON for machine consumption.
 */

import type { AnyCommandResult, OutputOptions } from "./types.js";

const C1_CONTROL_CHARACTER_PATTERN = new RegExp("[\\u007f-\\u009f]", "g");

function stringifyJson(value: unknown, indentation?: number): string {
  const json = JSON.stringify(value, null, indentation);
  if (json === undefined) {
    return "";
  }
  return json.replace(C1_CONTROL_CHARACTER_PATTERN, (character) => {
    const code = character.charCodeAt(0).toString(16).padStart(4, "0");
    return `\\u${code}`;
  });
}

/** Render command result as JSON */
export function renderJson<T>(result: AnyCommandResult<T>, _options: OutputOptions): string {
  const { schema } = result;

  // Apply custom serializer if provided
  if (schema.serialize) {
    if (result.type === "list") {
      // If all items serialize to the same object, return just one
      // This handles the case where a list of key-value rows should serialize
      // to a single structured object
      const serialized = result.data.map((item) => schema.serialize!(item));
      if (serialized.length > 0) {
        const first = stringifyJson(serialized[0]);
        const allSame = serialized.every((item) => stringifyJson(item) === first);
        if (allSame) {
          return stringifyJson(serialized[0], 2);
        }
      }
      return stringifyJson(serialized, 2);
    } else {
      const serialized = schema.serialize(result.data);
      return stringifyJson(serialized, 2);
    }
  }

  return stringifyJson(result.data, 2);
}

/** Render a single item as JSON line (for NDJSON streaming) */
export function renderJsonLine<T>(item: T, serialize?: (data: T) => unknown): string {
  const output = serialize ? serialize(item) : item;
  return stringifyJson(output);
}
