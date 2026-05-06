import type { Command } from "commander";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import { collectMultiple } from "../../utils/command-options.js";
import type { CommandError, CommandOptions, SingleResult } from "../../output/index.js";
import { agentRunSchema, type AgentRunResult } from "./run.js";
import type { AgentSnapshotPayload } from "@getpaseo/server";

const IMPORT_PROVIDERS = new Set(["claude", "codex", "opencode", "acp"]);

export function addImportOptions(cmd: Command): Command {
  return cmd
    .description("Import an existing provider session as a Paseo agent")
    .argument("<id>", "Provider session/thread ID to import")
    .requiredOption("--provider <provider>", "Agent provider: claude, codex, opencode, or acp")
    .option("--cwd <path>", "Working directory for providers that require it")
    .option(
      "--label <key=value>",
      "Add label(s) to the agent (can be used multiple times)",
      collectMultiple,
      [],
    );
}

export interface AgentImportOptions extends CommandOptions {
  provider?: string;
  cwd?: string;
  label?: string[];
  host?: string;
}

export type AgentImportCommandResult = SingleResult<AgentRunResult>;

function toImportResult(agent: AgentSnapshotPayload): AgentRunResult {
  return {
    agentId: agent.id,
    status: agent.status === "running" ? "running" : "created",
    provider: agent.provider,
    cwd: agent.cwd,
    title: agent.title,
  };
}

function parseImportProvider(provider: string | undefined): string {
  const normalizedProvider = provider?.trim();
  if (!normalizedProvider) {
    throw {
      code: "MISSING_PROVIDER",
      message: "Provider is required",
      details: "Usage: paseo import --provider <provider> <id>",
    } satisfies CommandError;
  }

  if (!IMPORT_PROVIDERS.has(normalizedProvider)) {
    throw {
      code: "INVALID_PROVIDER",
      message: `Unsupported provider: ${normalizedProvider}`,
      details: "Supported providers: claude, codex, opencode, acp",
    } satisfies CommandError;
  }

  return normalizedProvider;
}

function parseImportLabels(labelFlags: string[] | undefined): Record<string, string> {
  const labels: Record<string, string> = {};
  if (!labelFlags) {
    return labels;
  }

  for (const labelFlag of labelFlags) {
    const eqIndex = labelFlag.indexOf("=");
    if (eqIndex === -1) {
      throw {
        code: "INVALID_LABEL",
        message: `Invalid label format: ${labelFlag}`,
        details: "Labels must be in key=value format",
      } satisfies CommandError;
    }

    const key = labelFlag.slice(0, eqIndex).trim();
    if (!key) {
      throw {
        code: "INVALID_LABEL",
        message: `Invalid label format: ${labelFlag}`,
        details: "Labels must include a non-empty key in key=value format",
      } satisfies CommandError;
    }

    labels[key] = labelFlag.slice(eqIndex + 1);
  }

  return labels;
}

export function resolveImportCwd(explicitCwd: string | undefined, defaultCwd: string): string {
  const cwd = explicitCwd?.trim() ?? defaultCwd;
  if (!cwd.trim()) {
    throw {
      code: "INVALID_CWD",
      message: "--cwd cannot be empty",
      details: "Provide a working directory path or omit --cwd",
    } satisfies CommandError;
  }
  return cwd;
}

async function connectToDaemonOrThrow(
  hostOption: string | undefined,
  host: string,
): Promise<Awaited<ReturnType<typeof connectToDaemon>>> {
  try {
    return await connectToDaemon({ host: hostOption });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${host}: ${message}`,
      details: "Start the daemon with: paseo daemon start",
    } satisfies CommandError;
  }
}

export async function runImportCommand(
  sessionIdArg: string,
  options: AgentImportOptions,
  _command: Command,
): Promise<AgentImportCommandResult> {
  const host = getDaemonHost({ host: options.host });
  const sessionId = sessionIdArg.trim();
  if (!sessionId) {
    throw {
      code: "MISSING_SESSION_ID",
      message: "Session ID is required",
      details: "Usage: paseo import --provider <provider> <id>",
    } satisfies CommandError;
  }

  const provider = parseImportProvider(options.provider);
  const cwd = resolveImportCwd(options.cwd, process.cwd());

  const labels = parseImportLabels(options.label);
  const client = await connectToDaemonOrThrow(options.host, host);

  try {
    const agent = await client.importAgent({
      provider,
      sessionId,
      cwd,
      ...(Object.keys(labels).length > 0 ? { labels } : {}),
    });

    await client.close();

    return {
      type: "single",
      data: toImportResult(agent),
      schema: agentRunSchema,
    };
  } catch (err) {
    await client.close().catch(() => {});

    if (err && typeof err === "object" && "code" in err) {
      throw err;
    }

    const message = err instanceof Error ? err.message : String(err);
    throw {
      code: "AGENT_IMPORT_FAILED",
      message: `Failed to import agent: ${message}`,
    } satisfies CommandError;
  }
}
