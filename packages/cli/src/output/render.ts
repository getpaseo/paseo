/**
 * Main render dispatcher for CLI output.
 *
 * Selects the appropriate renderer based on output options.
 */

import chalk from "chalk";
import YAML from "yaml";
import type { AnyCommandResult, CommandError, OutputOptions } from "./types.js";
import { renderTable } from "./table.js";
import { renderJson } from "./json.js";
import { renderYaml } from "./yaml.js";
import { renderQuiet } from "./quiet.js";
import { defaultOutputOptions } from "./render-async.js";

export {
  defaultOutputOptions,
  renderAsync,
  renderErrorAsync,
  toCommandError,
} from "./render-async.js";

/** Render command result to string based on output options */
export function render<T>(
  result: AnyCommandResult<T>,
  options: Partial<OutputOptions> = {},
): string {
  const opts: OutputOptions = { ...defaultOutputOptions, ...options };

  // Quiet mode takes precedence
  if (opts.quiet) {
    return renderQuiet(result, opts);
  }

  // Dispatch to format-specific renderer
  switch (opts.format) {
    case "json":
      return renderJson(result, opts);
    case "yaml":
      return renderYaml(result, opts);
    case "table":
    default:
      if (result.schema.renderHuman) {
        return result.schema.renderHuman(result, opts);
      }
      return renderTable(result, opts);
  }
}

/** Render an error to string based on output options */
export function renderError(error: CommandError, options: Partial<OutputOptions> = {}): string {
  const opts: OutputOptions = { ...defaultOutputOptions, ...options };

  if (opts.format === "json") {
    return JSON.stringify({ error }, null, 2);
  }

  if (opts.format === "yaml") {
    return YAML.stringify({ error });
  }

  // Table/default format: human-readable error
  const prefix = opts.noColor ? "Error: " : chalk.red("Error: ");
  const message = error.message;

  if (error.details && typeof error.details === "string") {
    return `${prefix}${message}\n${error.details}`;
  }

  return `${prefix}${message}`;
}
