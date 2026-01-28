/**
 * YAML renderer for CLI output.
 *
 * Renders structured data as YAML for machine consumption and human readability.
 */

import YAML from 'yaml'
import type { AnyCommandResult, OutputOptions } from './types.js'

/** Render command result as YAML */
export function renderYaml<T>(
  result: AnyCommandResult<T>,
  _options: OutputOptions
): string {
  const { schema } = result

  // Apply custom serializer if provided
  if (schema.serialize) {
    if (result.type === 'list') {
      const serialized = result.data.map((item) => schema.serialize!(item))
      return YAML.stringify(serialized)
    } else {
      const serialized = schema.serialize(result.data)
      return YAML.stringify(serialized)
    }
  }

  return YAML.stringify(result.data)
}

/** Render a single item as YAML document (for streaming) */
export function renderYamlDoc<T>(item: T, serialize?: (data: T) => unknown): string {
  const output = serialize ? serialize(item) : item
  return YAML.stringify(output)
}
