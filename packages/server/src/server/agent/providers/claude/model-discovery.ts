import type { ChildProcess } from "node:child_process";
import os from "node:os";
import type { ModelInfo, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { raceProviderRefreshAbort } from "../../provider-refresh-deadline.js";
import type { ProviderRuntimeSettings } from "../../provider-launch-config.js";
import { terminateWithTreeKill } from "../../../../utils/tree-kill.js";
import { claudeQuery, type ClaudeQueryInput, type ClaudeQueryContext } from "./query.js";

const DISCOVERY_WAIT_MS = 5_000;
// Long enough for the CLI to finish an OAuth token refresh it started before the wait ended.
const DISCOVERY_EXIT_GRACE_MS = 60_000;

interface ClaudeModelDiscoveryOptions {
  resolveBinary: () => Promise<string>;
  runtimeSettings?: ProviderRuntimeSettings;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

type OpenDiscoveryQuery = (
  input: ClaudeQueryInput,
  context: ClaudeQueryContext,
) => Pick<Query, "supportedModels" | "close">;

type DiscoveryQuery = ReturnType<OpenDiscoveryQuery>;

// Discovery processes left to exit on their own after their caller stopped waiting.
const exitingDiscoveries = new Map<ChildProcess, () => Promise<void>>();

// The curated catalog survives a failed or slow probe. This process never receives
// a prompt and must not persist a session or launch user MCP servers/hooks.
export async function discoverClaudeModels(
  options: ClaudeModelDiscoveryOptions,
  openQuery: OpenDiscoveryQuery = claudeQuery,
): Promise<ModelInfo[]> {
  const waitController = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, waitController.signal])
    : waitController.signal;
  const timer = setTimeout(
    () => waitController.abort(new Error("Claude model discovery timed out")),
    DISCOVERY_WAIT_MS,
  );
  let endInput!: () => void;
  const ended = new Promise<void>((resolve) => {
    endInput = resolve;
  });
  const input: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          await ended;
          return { done: true, value: undefined };
        },
      };
    },
  };
  let query: DiscoveryQuery | undefined;
  let child: ChildProcess | undefined;
  try {
    signal.throwIfAborted();
    const binary = await raceProviderRefreshAbort(signal, options.resolveBinary());
    query = openQuery(
      {
        prompt: input,
        options: {
          pathToClaudeCodeExecutable: binary,
          cwd: os.homedir(),
          env: options.env,
          persistSession: false,
          tools: [],
          mcpServers: {},
          strictMcpConfig: true,
          settingSources: ["user"],
          settings: { disableAllHooks: true },
          // No abortController: the SDK kills the process when it aborts, and the end of
          // the wait must not.
        },
      },
      {
        runtimeSettings: options.runtimeSettings,
        onChildProcess: (process) => {
          child = process;
        },
      },
    );
    return await raceProviderRefreshAbort(signal, query.supportedModels());
  } finally {
    clearTimeout(timer);
    endInput();
    if (query && child && !hasExited(child)) {
      // The CLI may be refreshing an expired OAuth token, even after it has answered.
      // Claude Code rotates the refresh token before saving the new pair, so killing it now
      // leaves a revoked token on disk and logs the user out (#9314). With its input ended
      // it exits once that work is done; the grace period and daemon shutdown bound the wait.
      letDiscoveryExit(query, child);
    } else {
      await retireDiscovery(query, child);
    }
  }
}

/** Kills discovery processes still exiting after their wait ended. Called on daemon shutdown. */
export async function killExitingClaudeModelDiscoveries(): Promise<void> {
  await Promise.all(Array.from(exitingDiscoveries.values(), (kill) => kill()));
}

function letDiscoveryExit(query: DiscoveryQuery, child: ChildProcess): void {
  function forget(): void {
    clearTimeout(graceTimer);
    child.off("exit", onExit);
    exitingDiscoveries.delete(child);
  }
  function onExit(): void {
    forget();
    query.close();
  }
  async function kill(): Promise<void> {
    forget();
    await retireDiscovery(query, child);
  }
  const graceTimer = setTimeout(() => void kill(), DISCOVERY_EXIT_GRACE_MS);
  graceTimer.unref();
  child.once("exit", onExit);
  exitingDiscoveries.set(child, kill);
}

async function retireDiscovery(
  query: DiscoveryQuery | undefined,
  child: ChildProcess | undefined,
): Promise<void> {
  try {
    query?.close();
  } finally {
    if (child) {
      await terminateWithTreeKill(child, { gracefulTimeoutMs: 200, forceTimeoutMs: 200 });
    }
  }
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}
