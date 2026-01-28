/**
 * JSON renderer for CLI output.
 *
 * Renders structured data as formatted JSON for machine consumption.
 */

import type { AnyCommandResult, OutputOptions } from './types.js'

/** Render command result as JSON */
export function renderJson<T>(
  result: AnyCommandResult<T>,
  _options: OutputOptions
): string {
  const { schema } = result

  // Apply custom serializer if provided
  if (schema.serialize) {
    if (result.type === 'list') {
      const serialized = result.data.map((item) => schema.serialize!(item))
      return JSON.stringify(serialized, null, 2)
    } else {
      const serialized = schema.serialize(result.data)
      return JSON.stringify(serialized, null, 2)
    }
  }

  return JSON.stringify(result.data, null, 2)
}

/** Render a single item as JSON line (for NDJSON streaming) */
export function renderJsonLine<T>(item: T, serialize?: (data: T) => unknown): string {
  const output = serialize ? serialize(item) : item
  return JSON.stringify(output)
}
