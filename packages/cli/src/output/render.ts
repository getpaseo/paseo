/**
 * Synchronous render dispatcher for CLI output (primarily used in tests).
 */

import chalk from "chalk";
import YAML from "yaml";
import type { AnyCommandResult, CommandError, OutputOptions } from "./types.js";
import { renderTable } from "./table.js";
import { renderYaml } from "./yaml.js";
import { dispatchRender, dispatchRenderError, formatHumanError } from "./render-async.js";

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
  return dispatchRender(result, options, {
    yaml: (res, opts) => renderYaml(res, opts),
    table: (res, opts) => renderTable(res, opts),
  });
}

/** Render an error to string based on output options */
export function renderError(error: CommandError, options: Partial<OutputOptions> = {}): string {
  return dispatchRenderError(error, options, {
    yaml: (err) => YAML.stringify({ error: err }),
    redPrefix: () => formatHumanError(chalk.red("Error: "), error),
  });
}
