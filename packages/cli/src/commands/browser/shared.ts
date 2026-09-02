import { resolve } from "node:path";
import type { BrowserToolName } from "@getpaseo/protocol/browser-automation/rpc-schemas";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { CommandError, CommandOptions } from "../../output/index.js";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";

export interface BrowserCommandOptions extends CommandOptions {
  host?: string;
  cwd?: string;
  workspace?: string;
}

export interface BrowserToolInvocation {
  tool: BrowserToolName;
  input: Record<string, unknown>;
}

export interface BrowserToolCallResult {
  text: string;
  structuredContent: BrowserToolStructuredContent | undefined;
  ok: boolean;
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
}

export interface BrowserToolStructuredContent {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: { code?: string; message?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export async function connectBrowserClient(host?: string): Promise<{ client: DaemonClient }> {
  const daemonHost = getDaemonHost({ host });
  try {
    const client = await connectToDaemon({ host });
    return { client };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const error: CommandError = {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${daemonHost}: ${message}`,
      details: "Start the daemon with: paseo daemon start",
    };
    throw error;
  }
}

export function toBrowserCommandError(code: string, action: string, err: unknown): CommandError {
  if (err && typeof err === "object" && "code" in err && "message" in err) {
    return err as CommandError;
  }
  const message = err instanceof Error ? err.message : String(err);
  const rpcCode =
    typeof err === "object" && err !== null && "code" in err && typeof err.code === "string"
      ? err.code
      : undefined;
  return { code: rpcCode ?? code, message: `Failed to ${action}: ${message}` };
}

/**
 * Resolves the workspace the browser tab belongs to, mirroring how an agent's workspace scopes
 * its tabs. Returns undefined outside a workspace so the daemon can answer with the same
 * guidance agents get instead of the CLI inventing its own error.
 */
export async function resolveBrowserWorkspaceId(
  client: DaemonClient,
  options: BrowserCommandOptions,
): Promise<string | undefined> {
  if (options.workspace) {
    return options.workspace;
  }
  const cwd = resolve(options.cwd ?? process.cwd());
  const payload = await client.fetchWorkspaces({ page: { limit: 200 } });
  const matches = payload.entries.filter(
    (workspace) => resolve(workspace.workspaceDirectory) === cwd,
  );
  if (matches.length > 1) {
    const error: CommandError = {
      code: "WORKSPACE_AMBIGUOUS",
      message: `Multiple workspaces use ${cwd}`,
      details: "Pass --workspace <workspace-id> to select one.",
    };
    throw error;
  }
  return matches[0]?.id;
}

export async function callBrowserTool(
  invocation: BrowserToolInvocation,
  options: BrowserCommandOptions,
): Promise<BrowserToolCallResult> {
  const { client } = await connectBrowserClient(options.host);
  try {
    const workspaceId = await resolveBrowserWorkspaceId(client, options);
    const payload = await client.executeBrowserTool({
      tool: invocation.tool,
      input: invocation.input,
      cwd: resolve(options.cwd ?? process.cwd()),
      ...(workspaceId ? { workspaceId } : {}),
    });
    const result = payload.result;
    const text = result.content
      .filter((item) => item.type === "text" && typeof item.text === "string")
      .map((item) => item.text as string)
      .join("\n");
    const structuredContent = result.structuredContent as BrowserToolStructuredContent | undefined;
    return {
      text,
      structuredContent,
      ok: result.isError !== true && structuredContent?.ok !== false,
      content: result.content,
    };
  } catch (err) {
    throw toBrowserCommandError("BROWSER_TOOL_FAILED", `run ${invocation.tool}`, err);
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * The daemon reports tool-level failures inside the payload, so surface them as CLI errors
 * instead of printing a success row for a browser command that did not happen.
 */
export function assertBrowserToolSucceeded(
  tool: BrowserToolName,
  result: BrowserToolCallResult,
): void {
  if (result.ok) {
    return;
  }
  const error: CommandError = {
    code: result.structuredContent?.error?.code?.toUpperCase() ?? "BROWSER_TOOL_FAILED",
    message: result.text || `Failed to run ${tool}`,
    details: result.structuredContent?.error,
  };
  throw error;
}
