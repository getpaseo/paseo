/**
 * Output format types for the Junction CLI.
 *
 * This module defines the structured data types used by the output abstraction layer.
 * Commands return CommandResult<T> which contains both data and rendering metadata.
 */

/** Supported output formats */
export type OutputFormat = 'table' | 'json' | 'yaml'

/** Options controlling output rendering */
export interface OutputOptions {
  /** Output format (table, json, yaml) */
  format: OutputFormat
  /** Minimal output - IDs only */
  quiet: boolean
  /** Omit table headers */
  noHeaders: boolean
  /** Disable color output */
  noColor: boolean
}

/** Column definition for table output */
export interface ColumnDef<T> {
  /** Header text for the column */
  header: string
  /** Field key or accessor function */
  field: keyof T | ((item: T) => unknown)
  /** Optional width hint (characters) */
  width?: number
  /** Optional alignment */
  align?: 'left' | 'right' | 'center'
  /** Optional color function - returns chalk color name */
  color?: (value: unknown, item: T) => string | undefined
}

/** Schema describing how to render command output */
export interface OutputSchema<T> {
  /** Field to use for quiet mode (--quiet outputs just this) */
  idField: keyof T | ((item: T) => string)
  /** Column definitions for table output */
  columns: ColumnDef<T>[]
  /** Optional: transform data before JSON/YAML output */
  serialize?: (data: T) => unknown
}

/** Result type for commands returning a single item */
export interface SingleResult<T> {
  type: 'single'
  /** The structured data to render */
  data: T
  /** Schema describing how to render this data (for item type T) */
  schema: OutputSchema<T>
}

/** Result type for commands returning a list */
export interface ListResult<T> {
  type: 'list'
  /** The structured data to render */
  data: T[]
  /** Schema describing how to render this data (for item type T) */
  schema: OutputSchema<T>
}

/** Union type for all command results */
export type AnyCommandResult<T> = SingleResult<T> | ListResult<T>

/** Base interface for command results (deprecated, use SingleResult or ListResult) */
export type CommandResult<T> = SingleResult<T> | ListResult<T>

/** Structured error for command failures */
export interface CommandError {
  /** Machine-readable error code */
  code: string
  /** Human-readable message */
  message: string
  /** Additional context */
  details?: unknown
}
