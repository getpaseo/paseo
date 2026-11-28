/**
 * Shared output dispatch and lazy renderer for CLI runtime execution.
 *
 * Keeps `yaml` and `chalk` out of the hot `--json` and `--quiet` paths by loading
 * format-specific renderers only when that format is actually rendered.
 */

import type { AnyCommandResult, CommandError, OutputOptions } from "./types.js";
import { renderJson } from "./json.js";
import { renderQuiet } from "./quiet.js";

/** Default output options */
export const defaultOutputOptions: OutputOptions = {
  format: "table",
  quiet: false,
  noHeaders: false,
  noColor: false,
};

/** Convert an unknown error to a CommandError */
export function toCommandError(error: unknown): CommandError {
  if (isCommandError(error)) {
    // Error.message and class getters are not enumerable; materialize the output contract.
    return { ...error, code: error.code, message: error.message, details: error.details };
  }

  if (error instanceof Error) {
    return {
      code: "UNKNOWN_ERROR",
      message: error.message,
      details: error.stack,
    };
  }

  return {
    code: "UNKNOWN_ERROR",
    message: String(error),
  };
}

/** Type guard for CommandError */
function isCommandError(error: unknown): error is CommandError {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "message" in error &&
    typeof (error as CommandError).code === "string" &&
    typeof (error as CommandError).message === "string"
  );
}

/** Shared format switch used by both sync `render` and lazy `renderAsync` */
export function dispatchRender<T, R>(
  result: AnyCommandResult<T>,
  options: Partial<OutputOptions>,
  handlers: {
    yaml: (result: AnyCommandResult<T>, opts: OutputOptions) => R;
    table: (result: AnyCommandResult<T>, opts: OutputOptions) => R;
  },
): string | R {
  const opts: OutputOptions = { ...defaultOutputOptions, ...options };

  if (opts.quiet) {
    return renderQuiet(result, opts);
  }

  switch (opts.format) {
    case "json":
      return renderJson(result, opts);
    case "yaml":
      return handlers.yaml(result, opts);
    case "table":
    default:
      if (result.schema.renderHuman) {
        return result.schema.renderHuman(result, opts);
      }
      return handlers.table(result, opts);
  }
}

export function formatHumanError(prefix: string, error: CommandError): string {
  if (error.details && typeof error.details === "string") {
    return `${prefix}${error.message}\n${error.details}`;
  }
  return `${prefix}${error.message}`;
}

/** Shared error format switch used by both sync `renderError` and lazy `renderErrorAsync` */
export function dispatchRenderError<R>(
  error: CommandError,
  options: Partial<OutputOptions>,
  handlers: {
    yaml: (error: CommandError) => R;
    redPrefix: () => R;
  },
): string | R {
  const opts: OutputOptions = { ...defaultOutputOptions, ...options };

  if (opts.format === "json") {
    return JSON.stringify({ error }, null, 2);
  }

  if (opts.format === "yaml") {
    return handlers.yaml(error);
  }

  if (opts.noColor) {
    return formatHumanError("Error: ", error);
  }

  return handlers.redPrefix();
}

/** Render command result asynchronously, lazy-loading table/yaml formatters on demand */
export async function renderAsync<T>(
  result: AnyCommandResult<T>,
  options: Partial<OutputOptions> = {},
): Promise<string> {
  return await dispatchRender(result, options, {
    yaml: async (res, opts) => {
      const { renderYaml } = await import("./yaml.js");
      return renderYaml(res, opts);
    },
    table: async (res, opts) => {
      const { renderTable } = await import("./table.js");
      return renderTable(res, opts);
    },
  });
}

/** Render an error asynchronously, lazy-loading yaml/chalk only when needed */
export async function renderErrorAsync(
  error: CommandError,
  options: Partial<OutputOptions> = {},
): Promise<string> {
  return await dispatchRenderError(error, options, {
    yaml: async (err) => {
      const { default: YAML } = await import("yaml");
      return YAML.stringify({ error: err });
    },
    redPrefix: async () => {
      const { default: chalk } = await import("chalk");
      return formatHumanError(chalk.red("Error: "), error);
    },
  });
}
