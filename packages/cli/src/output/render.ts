/**
 * Main render dispatcher for CLI output.
 *
 * Selects the appropriate renderer based on output options.
 */

import chalk from 'chalk'
import YAML from 'yaml'
import type { AnyCommandResult, CommandError, OutputOptions } from './types.js'
import { renderTable } from './table.js'
import { renderJson } from './json.js'
import { renderYaml } from './yaml.js'
import { renderQuiet } from './quiet.js'

/** Default output options */
export const defaultOutputOptions: OutputOptions = {
  format: 'table',
  quiet: false,
  noHeaders: false,
  noColor: false,
}

/** Render command result to string based on output options */
export function render<T>(
  result: AnyCommandResult<T>,
  options: Partial<OutputOptions> = {}
): string {
  const opts: OutputOptions = { ...defaultOutputOptions, ...options }

  // Quiet mode takes precedence
  if (opts.quiet) {
    return renderQuiet(result, opts)
  }

  // Dispatch to format-specific renderer
  switch (opts.format) {
    case 'json':
      return renderJson(result, opts)
    case 'yaml':
      return renderYaml(result, opts)
    case 'table':
    default:
      return renderTable(result, opts)
  }
}

/** Convert an unknown error to a CommandError */
export function toCommandError(error: unknown): CommandError {
  if (isCommandError(error)) {
    return error
  }

  if (error instanceof Error) {
    return {
      code: 'UNKNOWN_ERROR',
      message: error.message,
      details: error.stack,
    }
  }

  return {
    code: 'UNKNOWN_ERROR',
    message: String(error),
  }
}

/** Type guard for CommandError */
function isCommandError(error: unknown): error is CommandError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    'message' in error &&
    typeof (error as CommandError).code === 'string' &&
    typeof (error as CommandError).message === 'string'
  )
}

/** Render an error to string based on output options */
export function renderError(
  error: CommandError,
  options: Partial<OutputOptions> = {}
): string {
  const opts: OutputOptions = { ...defaultOutputOptions, ...options }

  if (opts.format === 'json') {
    return JSON.stringify({ error }, null, 2)
  }

  if (opts.format === 'yaml') {
    return YAML.stringify({ error })
  }

  // Table/default format: human-readable error
  const prefix = opts.noColor ? 'Error: ' : chalk.red('Error: ')
  const message = error.message

  if (error.details && typeof error.details === 'string') {
    return `${prefix}${message}\n${error.details}`
  }

  return `${prefix}${message}`
}
