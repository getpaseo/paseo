/**
 * Command wrapper for automatic output rendering.
 *
 * Wraps command handlers to automatically render results and handle errors.
 */

import type { Command } from 'commander'
import type { AnyCommandResult, CommandError, OutputOptions } from './types.js'
import { render, renderError, toCommandError, defaultOutputOptions } from './render.js'

/** Options that include output settings from global options */
export interface CommandOptions extends Partial<OutputOptions> {
  [key: string]: unknown
}

function normalizeFormat(raw: unknown): OutputOptions['format'] {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : ''

  // Common user expectation: "cli" means "table/human"
  if (value === 'cli') return 'table'

  if (value === 'table' || value === 'json' || value === 'yaml') return value

  const error: CommandError = {
    code: 'INVALID_FORMAT',
    message: `Unsupported output format: ${String(raw)}`,
    details: 'Supported formats: table, json, yaml',
  }
  throw error
}

/** Extract output options from command options */
function extractOutputOptions(options: CommandOptions): OutputOptions {
  return {
    format: options.json ? 'json' : normalizeFormat(options.format ?? defaultOutputOptions.format),
    quiet: options.quiet ?? defaultOutputOptions.quiet,
    noHeaders: options.headers === false, // Commander uses --no-headers -> headers: false
    noColor: options.color === false, // Commander uses --no-color -> color: false
  }
}

/**
 * Wrap a command handler to automatically render output.
 *
 * The wrapped handler should return a CommandResult. The wrapper will:
 * 1. Call the handler
 * 2. Render the result using the appropriate format
 * 3. Write to stdout
 * 4. Handle errors by rendering to stderr and exiting with code 1
 *
 * @example
 * ```typescript
 * program
 *   .command('list')
 *   .action(withOutput(async (options) => {
 *     const data = await fetchData()
 *     return { type: 'list', data, schema }
 *   }))
 * ```
 */
export function withOutput<T, Args extends unknown[]>(
  handler: (...args: [...Args, CommandOptions, Command]) => Promise<AnyCommandResult<T>>
): (...args: [...Args, CommandOptions, Command]) => Promise<void> {
  return async (...args) => {
    // Last two args are options and command
    const command = args[args.length - 1] as Command
    // Use optsWithGlobals() to get both local and global options
    const options = command.optsWithGlobals() as CommandOptions
    const outputOptions = extractOutputOptions(options)

    try {
      const result = await handler(...args)
      const output = render(result, outputOptions)

      if (output) {
        process.stdout.write(output + '\n')
      }
    } catch (error) {
      const commandError = toCommandError(error)
      const errorOutput = renderError(commandError, outputOptions)
      process.stderr.write(errorOutput + '\n')
      process.exit(1)
    }
  }
}

/**
 * Helper to create output options from partial input.
 * Useful for testing or manual rendering.
 */
export function createOutputOptions(
  partial: Partial<OutputOptions> = {}
): OutputOptions {
  return { ...defaultOutputOptions, ...partial }
}
