import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { ProviderRefreshContext } from "../../agent-sdk-types.js";
import {
  DEFAULT_PROVIDER_REFRESH_TIMEOUT_MS,
  PROVIDER_REFRESH_ABORT_CLEANUP_TIMEOUT_MS,
  raceProviderRefreshAbort,
  runProviderRefreshWithDeadline,
} from "../../provider-refresh-deadline.js";
import { withTimeout } from "../../../../utils/promise-timeout.js";
import type { CodexAppServerClient } from "./app-server-transport.js";

type StartupClient = Pick<CodexAppServerClient, "request" | "notify" | "dispose">;
interface StartOptions<T extends StartupClient> {
  stateDirectory: string;
  createClient: () => Promise<T>;
  initializeParams: unknown;
  context?: ProviderRefreshContext;
}

// Aliases and interactive sessions share Codex's SQLite state. Only startup is
// exclusive; initialized app servers and their conversations remain concurrent.
const startups = new Map<string, Promise<void>>();

function stateDirectoryKey(directory: string): string {
  const absolute = resolve(directory);
  try {
    return realpathSync(absolute);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return absolute;
    throw error;
  }
}

export async function startCodexAppServer<T extends StartupClient>(
  options: StartOptions<T>,
): Promise<T> {
  const key = stateDirectoryKey(options.stateDirectory);
  const previous = startups.get(key) ?? Promise.resolve();
  const result = previous.then(() => {
    if (options.context) return initialize(options, options.context);
    return runProviderRefreshWithDeadline({
      label: "Codex startup",
      timeoutMs: DEFAULT_PROVIDER_REFRESH_TIMEOUT_MS,
      operation: (context) => initialize(options, context),
    });
  });
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  startups.set(key, tail);
  void tail.then(() => {
    if (startups.get(key) === tail) startups.delete(key);
    return undefined;
  });
  return result;
}

async function initialize<T extends StartupClient>(
  options: StartOptions<T>,
  context: ProviderRefreshContext,
): Promise<T> {
  context.signal.throwIfAborted();
  const creating = options.createClient();
  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= creating.then(
      (client) => client.dispose(),
      () => undefined,
    );
    return closing;
  };
  const unregister = context.registerAbortCleanup(close);
  try {
    const client = await context.runActivity("app-server.start", () =>
      raceProviderRefreshAbort(context.signal, creating),
    );
    await context.runActivity("initialize", () =>
      raceProviderRefreshAbort(
        context.signal,
        client.request("initialize", options.initializeParams),
      ),
    );
    client.notify("initialized", {});
    return client;
  } catch (error) {
    // A spawn that completes after cancellation still owns its eventual cleanup.
    await withTimeout(
      close(),
      PROVIDER_REFRESH_ABORT_CLEANUP_TIMEOUT_MS,
      "Codex startup cleanup timed out",
    ).catch(() => undefined);
    throw error;
  } finally {
    unregister();
  }
}
