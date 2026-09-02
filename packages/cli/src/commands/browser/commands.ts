/**
 * Handlers for `paseo browser` subcommands.
 *
 * Every handler is a thin adapter: it turns CLI arguments into the input the matching
 * `browser_*` tool already accepts and hands it to the daemon's browser tool catalog.
 */

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Command } from "commander";
import type { BrowserToolName } from "@getpaseo/protocol/browser-automation/rpc-schemas";
import type { CommandError, ListResult, SingleResult } from "../../output/index.js";
import type { BrowserResultRow, BrowserTabRow } from "./schema.js";
import { browserTabSchema, toBrowserResult } from "./schema.js";
import type { BrowserCommandOptions } from "./shared.js";
import { assertBrowserToolSucceeded, callBrowserTool } from "./shared.js";

export interface BrowserClickOptions extends BrowserCommandOptions {
  button?: string;
  doubleClick?: boolean;
  modifiers?: string[];
}

export interface BrowserRefOptions extends BrowserCommandOptions {
  ref?: string;
}

export interface BrowserWaitOptions extends BrowserCommandOptions {
  text?: string;
  url?: string;
  timeout?: string;
}

export interface BrowserLogsOptions extends BrowserCommandOptions {
  maxEntries?: string;
}

export interface BrowserScreenshotOptions extends BrowserCommandOptions {
  fullPage?: boolean;
  out?: string;
}

function parseIntegerOption(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    const error: CommandError = {
      code: "INVALID_NUMBER",
      message: `${flag} must be an integer`,
      details: `Received: ${value}`,
    };
    throw error;
  }
  return parsed;
}

function parseNumberArgument(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    const error: CommandError = {
      code: "INVALID_NUMBER",
      message: `${name} must be a number`,
      details: `Received: ${value}`,
    };
    throw error;
  }
  return parsed;
}

async function runBrowserTool(
  tool: BrowserToolName,
  input: Record<string, unknown>,
  options: BrowserCommandOptions,
): Promise<SingleResult<BrowserResultRow>> {
  const result = await callBrowserTool({ tool, input }, options);
  assertBrowserToolSucceeded(tool, result);
  return toBrowserResult(tool, result);
}

export async function runNewTabCommand(
  url: string | undefined,
  options: BrowserCommandOptions,
  _command: Command,
): Promise<SingleResult<BrowserResultRow>> {
  return runBrowserTool("browser_new_tab", url ? { url } : {}, options);
}

export async function runTabsCommand(
  options: BrowserCommandOptions,
  _command: Command,
): Promise<ListResult<BrowserTabRow>> {
  const result = await callBrowserTool({ tool: "browser_list_tabs", input: {} }, options);
  assertBrowserToolSucceeded("browser_list_tabs", result);
  const tabs = result.structuredContent?.result?.tabs;
  const rows = Array.isArray(tabs)
    ? (tabs as Array<Record<string, unknown>>).map((tab) => ({
        browserId: String(tab.browserId ?? ""),
        title: String(tab.title ?? ""),
        url: String(tab.url ?? ""),
        isActive: tab.isActive === true,
        isLoading: tab.isLoading === true,
      }))
    : [];
  return { type: "list", data: rows, schema: browserTabSchema };
}

export async function runNavigateCommand(
  browserId: string,
  url: string,
  options: BrowserCommandOptions,
  _command: Command,
): Promise<SingleResult<BrowserResultRow>> {
  return runBrowserTool("browser_navigate", { browserId, url }, options);
}

export async function runClickCommand(
  browserId: string,
  ref: string,
  options: BrowserClickOptions,
  _command: Command,
): Promise<SingleResult<BrowserResultRow>> {
  return runBrowserTool(
    "browser_click",
    {
      browserId,
      ref,
      ...(options.button ? { button: options.button } : {}),
      ...(options.doubleClick ? { doubleClick: true } : {}),
      ...(options.modifiers?.length ? { modifiers: options.modifiers } : {}),
    },
    options,
  );
}

export async function runFillCommand(
  browserId: string,
  ref: string,
  value: string,
  options: BrowserCommandOptions,
  _command: Command,
): Promise<SingleResult<BrowserResultRow>> {
  return runBrowserTool("browser_fill", { browserId, ref, value }, options);
}

export async function runTypeCommand(
  browserId: string,
  text: string,
  options: BrowserRefOptions,
  _command: Command,
): Promise<SingleResult<BrowserResultRow>> {
  return runBrowserTool(
    "browser_type",
    { browserId, text, ...(options.ref ? { ref: options.ref } : {}) },
    options,
  );
}

export async function runSelectCommand(
  browserId: string,
  ref: string,
  value: string,
  options: BrowserCommandOptions,
  _command: Command,
): Promise<SingleResult<BrowserResultRow>> {
  return runBrowserTool("browser_select", { browserId, ref, value }, options);
}

export async function runDragCommand(
  browserId: string,
  sourceRef: string,
  targetRef: string,
  options: BrowserCommandOptions,
  _command: Command,
): Promise<SingleResult<BrowserResultRow>> {
  return runBrowserTool("browser_drag", { browserId, sourceRef, targetRef }, options);
}

export async function runHoverCommand(
  browserId: string,
  ref: string,
  options: BrowserCommandOptions,
  _command: Command,
): Promise<SingleResult<BrowserResultRow>> {
  return runBrowserTool("browser_hover", { browserId, ref }, options);
}

export async function runKeypressCommand(
  browserId: string,
  key: string,
  options: BrowserRefOptions,
  _command: Command,
): Promise<SingleResult<BrowserResultRow>> {
  return runBrowserTool(
    "browser_keypress",
    { browserId, key, ...(options.ref ? { ref: options.ref } : {}) },
    options,
  );
}

export async function runScrollCommand(
  browserId: string,
  deltaX: string,
  deltaY: string,
  options: BrowserRefOptions,
  _command: Command,
): Promise<SingleResult<BrowserResultRow>> {
  return runBrowserTool(
    "browser_scroll",
    {
      browserId,
      deltaX: parseNumberArgument(deltaX, "deltaX"),
      deltaY: parseNumberArgument(deltaY, "deltaY"),
      ...(options.ref ? { ref: options.ref } : {}),
    },
    options,
  );
}

export async function runUploadCommand(
  browserId: string,
  ref: string,
  filePaths: string[],
  options: BrowserCommandOptions,
  _command: Command,
): Promise<SingleResult<BrowserResultRow>> {
  return runBrowserTool(
    "browser_upload",
    { browserId, ref, filePaths: filePaths.map((filePath) => resolve(filePath)) },
    options,
  );
}

export async function runEvaluateCommand(
  browserId: string,
  fn: string,
  options: BrowserRefOptions,
  _command: Command,
): Promise<SingleResult<BrowserResultRow>> {
  return runBrowserTool(
    "browser_evaluate",
    { browserId, function: fn, ...(options.ref ? { ref: options.ref } : {}) },
    options,
  );
}

export async function runSnapshotCommand(
  browserId: string,
  options: BrowserCommandOptions,
  _command: Command,
): Promise<SingleResult<BrowserResultRow>> {
  return runBrowserTool("browser_snapshot", { browserId }, options);
}

export async function runWaitCommand(
  browserId: string,
  options: BrowserWaitOptions,
  _command: Command,
): Promise<SingleResult<BrowserResultRow>> {
  return runBrowserTool(
    "browser_wait",
    {
      browserId,
      ...(options.text ? { text: options.text } : {}),
      ...(options.url ? { url: options.url } : {}),
      ...(options.timeout ? { timeoutMs: parseIntegerOption(options.timeout, "--timeout") } : {}),
    },
    options,
  );
}

export async function runLogsCommand(
  browserId: string,
  options: BrowserLogsOptions,
  _command: Command,
): Promise<SingleResult<BrowserResultRow>> {
  return runBrowserTool(
    "browser_logs",
    {
      browserId,
      ...(options.maxEntries
        ? { maxEntries: parseIntegerOption(options.maxEntries, "--max-entries") }
        : {}),
    },
    options,
  );
}

export async function runScreenshotCommand(
  browserId: string,
  options: BrowserScreenshotOptions,
  _command: Command,
): Promise<SingleResult<BrowserResultRow>> {
  const tool: BrowserToolName = "browser_screenshot";
  const result = await callBrowserTool(
    { tool, input: { browserId, fullPage: options.fullPage === true } },
    options,
  );
  assertBrowserToolSucceeded(tool, result);
  if (options.out) {
    const image = result.content.find((item) => item.type === "image");
    const data = image?.data;
    if (typeof data !== "string") {
      const error: CommandError = {
        code: "BROWSER_SCREENSHOT_EMPTY",
        message: "Daemon returned no screenshot image data",
      };
      throw error;
    }
    const outPath = resolve(options.out);
    await writeFile(outPath, Buffer.from(data, "base64"));
    const single = toBrowserResult(tool, result);
    single.data.summary = `${single.data.summary}\nSaved screenshot to ${outPath}`;
    return single;
  }
  return toBrowserResult(tool, result);
}

export async function runResizeCommand(
  browserId: string,
  width: string,
  height: string,
  options: BrowserCommandOptions,
  _command: Command,
): Promise<SingleResult<BrowserResultRow>> {
  return runBrowserTool(
    "browser_resize",
    {
      browserId,
      width: parseIntegerOption(width, "width"),
      height: parseIntegerOption(height, "height"),
    },
    options,
  );
}

export async function runCloseTabCommand(
  browserId: string,
  options: BrowserCommandOptions,
  _command: Command,
): Promise<SingleResult<BrowserResultRow>> {
  return runBrowserTool("browser_close_tab", { browserId }, options);
}

export async function runReloadCommand(
  browserId: string,
  options: BrowserCommandOptions,
  _command: Command,
): Promise<SingleResult<BrowserResultRow>> {
  return runBrowserTool("browser_reload", { browserId }, options);
}

export async function runBackCommand(
  browserId: string,
  options: BrowserCommandOptions,
  _command: Command,
): Promise<SingleResult<BrowserResultRow>> {
  return runBrowserTool("browser_back", { browserId }, options);
}

export async function runForwardCommand(
  browserId: string,
  options: BrowserCommandOptions,
  _command: Command,
): Promise<SingleResult<BrowserResultRow>> {
  return runBrowserTool("browser_forward", { browserId }, options);
}
