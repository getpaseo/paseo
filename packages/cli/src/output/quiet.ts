/**
 * Quiet renderer for CLI output.
 *
 * Outputs only ID fields, one per line. Useful for scripting and pipelines.
 */

import type { AnyCommandResult, OutputOptions } from './types.js'

/** Extract ID from item using schema definition */
function getId<T>(item: T, idField: keyof T | ((item: T) => string)): string {
  if (typeof idField === 'function') {
    return idField(item)
  }
  return String(item[idField])
}

/** Render command result in quiet mode (IDs only) */
export function renderQuiet<T>(
  result: AnyCommandResult<T>,
  _options: OutputOptions
): string {
  if (result.type === 'single') {
    return getId(result.data, result.schema.idField)
  } else {
    return result.data.map((item) => getId(item, result.schema.idField)).join('\n')
  }
}
