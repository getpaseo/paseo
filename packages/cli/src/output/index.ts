/**
 * Output abstraction layer for the Paseo CLI.
 *
 * This module provides structured output rendering with support for multiple formats:
 * - table: Human-readable aligned tables (default)
 * - json: Machine-readable JSON
 * - yaml: Machine-readable YAML
 * - quiet: Minimal output (IDs only)
 *
 * @example
 * ```typescript
 * import { withOutput, render, type ListResult, type OutputSchema } from './output/index.js'
 *
 * // Define your data type
 * interface Agent { id: string; title: string; status: string }
 *
 * // Define how to render it
 * const schema: OutputSchema<Agent> = {
 *   idField: 'id',
 *   columns: [
 *     { header: 'ID', field: 'id' },
 *     { header: 'TITLE', field: 'title' },
 *     { header: 'STATUS', field: 'status', color: (v) => v === 'running' ? 'green' : undefined },
 *   ],
 * }
 *
 * // Return structured data from commands
 * const result: ListResult<Agent> = {
 *   type: 'list',
 *   data: agents,
 *   schema,
 * }
 *
 * // Render with options
 * const output = render(result, { format: 'json' })
 * ```
 */

// Types
export type {
  OutputFormat,
  OutputOptions,
  ColumnDef,
  OutputSchema,
  CommandResult,
  SingleResult,
  ListResult,
  AnyCommandResult,
  CommandError,
} from "./types.js";

// Zero-dep renderers and lazy runtime renderers (avoid importing yaml/chalk on --json)
export { renderJson, renderJsonLine } from "./json.js";
export { renderQuiet } from "./quiet.js";
export {
  renderAsync,
  renderErrorAsync,
  toCommandError,
  defaultOutputOptions,
} from "./render-async.js";

// Command wrapper
export { withOutput, createOutputOptions, type CommandOptions } from "./with-output.js";
