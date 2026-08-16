import type { WorkspaceFileContent, WorkspaceFileRead, WorkspaceWatchEvent } from "./files.js";
import type { WorkspaceFilesOwner, WorkspaceHelperProcess } from "./binding.js";
import {
  describeSchema,
  directorySchema,
  fileStatSchema,
  resolvedCommandSchema,
  watchEventSchema,
  writeResultSchema,
} from "./protocol.js";
import type { z } from "zod";

interface WatchState {
  process: WorkspaceHelperProcess;
  subscriptions: Map<string, (event: WorkspaceWatchEvent) => void>;
  acknowledgements: Map<string, { resolve(): void; reject(error: Error): void }>;
  closed: boolean;
  cleanup: Promise<void> | null;
  diagnostics: Promise<string>;
  ready: boolean;
}

interface LogicalWatchSubscription {
  input: { paths: readonly string[]; recursive?: boolean; ignoredPaths?: readonly string[] };
  listener: (event: WorkspaceWatchEvent) => void;
}

const WATCH_ACKNOWLEDGEMENT_TIMEOUT_MS = 3_000;
const WATCH_CLOSE_TIMEOUT_MS = 500;
const PROCESS_STOP_TIMEOUT_MS = 1_000;

export function createClient(options: {
  launch(argv: readonly [string, ...string[]]): Promise<WorkspaceHelperProcess>;
  command: readonly [string, ...string[]];
}): WorkspaceFilesOwner {
  let watcher: WatchState | null = null;
  let nextSubscriptionId = 0;
  let closing = false;
  let closePromise: Promise<void> | null = null;
  let watcherRecovery: Promise<void> | null = null;
  let watcherStart: Promise<WatchState> | null = null;
  let replayAfterFailure = false;
  const watchSubscriptions = new Map<string, LogicalWatchSubscription>();
  const processes = new Set<WorkspaceHelperProcess>();

  const command = async (name: string, args: readonly string[] = []) => {
    if (closing) throw new Error("Workspace files client is closed");
    const child = await options.launch([...options.command, name, ...args]);
    processes.add(child);
    void child.exited.then(
      () => processes.delete(child),
      () => processes.delete(child),
    );
    if (closing) {
      await terminate(child);
      throw new Error("Workspace files client is closed");
    }
    return child;
  };

  async function json<T extends z.ZodType>(
    name: string,
    args: readonly string[],
    schema: T,
  ): Promise<z.output<T>> {
    const child = await command(name, args);
    child.stdin.end();
    const [stdout, stderr, exit] = await Promise.all([
      collect(child.stdout),
      collect(child.stderr),
      child.exited,
    ]);
    if (exit.code !== 0 || exit.signal !== null) throw helperError(stderr, exit);
    return schema.parse(JSON.parse(stdout));
  }

  return {
    files: {
      stat(path) {
        return json("fs-stat", ["--path", requireRelativePath(path)], fileStatSchema);
      },
      list(path) {
        return json("fs-list", ["--path", requireRelativePath(path)], directorySchema);
      },
      async read(path) {
        path = requireRelativePath(path);
        const metadata = await json("fs-stat", ["--path", path], fileStatSchema);
        if (metadata.status !== "ready") {
          throw new Error(metadata.status === "error" ? metadata.error : `File not found: ${path}`);
        }
        const child = await command("fs-read", ["--path", path]);
        child.stdin.end();
        const stderr = collect(child.stderr);
        const chunks = ownedRead(child, stderr, async () => {
          const final = await json("fs-stat", ["--path", path], fileStatSchema);
          if (final.status !== "ready" || final.revision !== metadata.revision) {
            throw new Error("File changed during transfer");
          }
        });
        return { ...metadata, chunks } satisfies WorkspaceFileRead;
      },
      async write(input) {
        const writtenPath = requireRelativePath(input.path);
        const args = ["--path", writtenPath];
        if (input.expectedModifiedAt) args.push("--expected-modified-at", input.expectedModifiedAt);
        if (input.expectedRevision) args.push("--expected-revision", input.expectedRevision);
        const child = await command("fs-write", args);
        const stdout = collect(child.stdout);
        const stderr = collect(child.stderr);
        try {
          if (input.contents instanceof Uint8Array) {
            child.stdin.end(input.contents);
          } else {
            for await (const chunk of input.contents) {
              if (!child.stdin.write(chunk)) await onceDrain(child.stdin);
            }
            child.stdin.end();
          }
        } catch (error) {
          await terminate(child);
          throw error;
        }
        const [body, diagnostics, exit] = await Promise.all([stdout, stderr, child.exited]);
        if (exit.code !== 0 || exit.signal !== null) throw helperError(diagnostics, exit);
        const result = writeResultSchema.parse(JSON.parse(body));
        if (result.status === "written") notifyWrite(writtenPath);
        return result;
      },
      async subscribe(input, listener) {
        if (closing) throw new Error("Workspace files client is closed");
        const confinedInput = {
          ...input,
          paths: input.paths.map(requireRelativePath),
          ...(input.ignoredPaths
            ? { ignoredPaths: input.ignoredPaths.map(requireRelativePath) }
            : {}),
        };
        const id = `subscription-${++nextSubscriptionId}`;
        watchSubscriptions.set(id, { input: confinedInput, listener });
        let state: WatchState | null = null;
        try {
          state = await requireWatcher();
          if (state.subscriptions.has(id)) return subscriptionFor(id);
          state.subscriptions.set(id, listener);
          await sendSubscription(state, id, confinedInput);
        } catch (error) {
          watchSubscriptions.delete(id);
          state?.subscriptions.delete(id);
          throw error;
        }
        return subscriptionFor(id);
      },
    },
    async resolveCommand(commandName) {
      const result = await json("resolve-command", ["--name", commandName], resolvedCommandSchema);
      return result.path;
    },
    async verify() {
      const description = await json("describe", [], describeSchema);
      if (
        !description.capabilities.includes("files") ||
        !description.capabilities.includes("watch") ||
        !description.capabilities.includes("resolve-command")
      ) {
        throw new Error(
          "Workspace helper does not support files, watching, and command resolution",
        );
      }
    },
    async close(reason) {
      closePromise ??= (async () => {
        closing = true;
        watchSubscriptions.clear();
        if (watcher) {
          await stopWatcher(watcher, reason);
        }
        await watcherRecovery?.catch(() => undefined);
        await Promise.all([...processes].map((child) => terminate(child)));
      })();
      await closePromise;
    },
  };

  function subscriptionFor(id: string) {
    let active = true;
    return {
      async unsubscribe() {
        if (!active) return;
        active = false;
        watchSubscriptions.delete(id);
        await watcherRecovery?.catch(() => undefined);
        const state = watcher;
        state?.subscriptions.delete(id);
        if (state && !state.closed) {
          const removed = acknowledgement(state, `unsubscribed:${id}`);
          state.process.stdin.write(
            `${JSON.stringify({ protocolVersion: 1, type: "unsubscribe", id })}\n`,
          );
          try {
            await waitForAcknowledgement(
              state,
              `unsubscribed:${id}`,
              "Workspace helper unsubscribe acknowledgement timed out",
              removed,
            );
          } catch (error) {
            if (!(error instanceof Error) || error.message !== "Workspace helper watcher is closed")
              throw error;
          }
        }
        if (watchSubscriptions.size === 0 && state) await stopWatcher(state);
      },
    };
  }

  function notifyWrite(writtenPath: string): void {
    for (const subscription of watchSubscriptions.values()) {
      if (!subscriptionIncludesPath(subscription.input, writtenPath)) continue;
      subscription.listener({ type: "changed", paths: [writtenPath] });
    }
  }

  async function requireWatcher(): Promise<WatchState> {
    await watcherRecovery;
    if (watcherStart) return watcherStart;
    if (watcher && !watcher.closed) return watcher;
    return launchWatcher();
  }

  function launchWatcher(): Promise<WatchState> {
    watcherStart ??= startWatcher().finally(() => {
      watcherStart = null;
    });
    return watcherStart;
  }

  async function startWatcher(): Promise<WatchState> {
    const replaying = replayAfterFailure;
    const process = await command("watch");
    const state: WatchState = {
      process,
      subscriptions: new Map(),
      acknowledgements: new Map(),
      closed: false,
      cleanup: null,
      diagnostics: collect(process.stderr),
      ready: false,
    };
    watcher = state;
    process.stdin.on("error", () => undefined);
    const ready = acknowledgement(state, "ready");
    void consumeLines(process.stdout, (line) => handleWatchEvent(state, line))
      .then(
        () => failWatcher(state, new Error("Workspace helper watcher output ended")),
        (error) => failWatcher(state, toError(error)),
      )
      .catch(() => undefined);
    void process.exited
      .then(
        (exit) => {
          return failWatcher(
            state,
            new Error(`Workspace helper watcher exited: ${exit.code ?? exit.signal}`),
          );
        },
        (error) => {
          return failWatcher(state, toError(error));
        },
      )
      .catch(() => undefined);
    await waitForAcknowledgement(
      state,
      "ready",
      "Workspace helper ready acknowledgement timed out",
      ready,
    );
    for (const [id, subscription] of watchSubscriptions) {
      state.subscriptions.set(id, subscription.listener);
      await sendSubscription(state, id, subscription.input);
    }
    state.ready = true;
    replayAfterFailure = false;
    if (replaying) {
      for (const subscription of watchSubscriptions.values()) {
        subscription.listener({ type: "changed", paths: [...subscription.input.paths] });
      }
    }
    return state;
  }

  async function sendSubscription(
    state: WatchState,
    id: string,
    input: LogicalWatchSubscription["input"],
  ): Promise<void> {
    const acknowledged = acknowledgement(state, `subscribed:${id}`);
    state.process.stdin.write(
      `${JSON.stringify({ protocolVersion: 1, type: "subscribe", id, paths: input.paths, recursive: input.recursive === true, ignoredPaths: input.ignoredPaths ?? [] })}\n`,
    );
    await waitForAcknowledgement(
      state,
      `subscribed:${id}`,
      "Workspace helper subscribe acknowledgement timed out",
      acknowledged,
    );
  }

  async function stopWatcher(state: WatchState, reason?: Error): Promise<void> {
    if (state.cleanup) return state.cleanup;
    if (state.closed) return;
    state.closed = true;
    if (watcher === state) watcher = null;
    if (reason) {
      for (const listener of state.subscriptions.values()) {
        listener({ type: "error", error: reason.message });
      }
    }
    state.subscriptions.clear();
    const closedError = reason ?? new Error("Workspace helper watcher is closed");
    for (const pending of state.acknowledgements.values()) pending.reject(closedError);
    state.acknowledgements.clear();
    state.process.stdin.end(`${JSON.stringify({ protocolVersion: 1, type: "close" })}\n`);
    state.cleanup = (async () => {
      const gracefulExit = await exitWithin(state.process.exited, WATCH_CLOSE_TIMEOUT_MS);
      if (!gracefulExit) await terminate(state.process);
      state.process.stdin.destroy();
      state.process.stdout.destroy();
      await state.diagnostics.catch(() => undefined);
      return undefined;
    })();
    await state.cleanup;
  }

  async function waitForAcknowledgement(
    state: WatchState,
    key: string,
    timeoutMessage: string,
    pending: Promise<void>,
  ): Promise<void> {
    try {
      await withTimeout(pending, WATCH_ACKNOWLEDGEMENT_TIMEOUT_MS, timeoutMessage);
    } catch (error) {
      state.acknowledgements.delete(key);
      const failure = toError(error);
      await failWatcher(state, failure);
      throw failure;
    }
  }

  async function failWatcher(state: WatchState, error: Error): Promise<void> {
    if (state.cleanup) return state.cleanup;
    if (state.closed) return;
    state.closed = true;
    if (watcher === state) watcher = null;
    state.subscriptions.clear();
    for (const pending of state.acknowledgements.values()) pending.reject(error);
    state.acknowledgements.clear();
    state.cleanup = terminate(state.process).then(async () => {
      state.process.stdin.destroy();
      state.process.stdout.destroy();
      await state.diagnostics.catch(() => undefined);
      return undefined;
    });
    if (!closing && state.ready && watchSubscriptions.size > 0 && !watcherRecovery) {
      replayAfterFailure = true;
      watcherRecovery = state.cleanup
        .then(async () => {
          if (!closing && watchSubscriptions.size > 0) await launchWatcher();
          return undefined;
        })
        .catch((recoveryError) => {
          for (const subscription of watchSubscriptions.values()) {
            subscription.listener({ type: "error", error: toError(recoveryError).message });
          }
        })
        .finally(() => {
          watcherRecovery = null;
        });
    }
    await state.cleanup;
  }
}

function handleWatchEvent(state: WatchState, line: string): void {
  const event = watchEventSchema.parse(JSON.parse(line));
  const subscriptionId = "subscriptionId" in event ? event.subscriptionId : undefined;
  let acknowledgementKey: string | null = null;
  if (event.type === "ready") acknowledgementKey = "ready";
  else if (subscriptionId) acknowledgementKey = `${event.type}:${subscriptionId}`;
  if (acknowledgementKey) {
    state.acknowledgements.get(acknowledgementKey)?.resolve();
    state.acknowledgements.delete(acknowledgementKey);
  }
  if (!subscriptionId) return;
  const listener = state.subscriptions.get(subscriptionId);
  if (!listener) return;
  if (event.type === "changed") listener({ type: "changed", paths: event.paths ?? [] });
  if (event.type === "overflow") listener({ type: "overflow" });
  if (event.type === "error") listener({ type: "error", error: event.message ?? "Watcher failed" });
}

function acknowledgement(state: WatchState, key: string): Promise<void> {
  const pending = new Promise<void>((resolve, reject) =>
    state.acknowledgements.set(key, { resolve, reject }),
  );
  void pending.catch(() => undefined);
  return pending;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function collect(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function ownedRead(
  child: WorkspaceHelperProcess,
  stderr: Promise<string>,
  verify: () => Promise<void>,
): WorkspaceFileContent {
  const source = child.stdout[Symbol.asyncIterator]();
  let iteratorCreated = false;
  let finished = false;
  let cancellation: Promise<void> | null = null;

  async function cancel(): Promise<void> {
    if (finished) return;
    cancellation ??= terminate(child).then(async () => {
      finished = true;
      child.stdout.destroy();
      child.stdin.destroy();
      await stderr.catch(() => undefined);
      return undefined;
    });
    await cancellation;
  }

  return {
    cancel,
    [Symbol.asyncIterator]() {
      if (iteratorCreated) throw new Error("Workspace file content can only be consumed once");
      iteratorCreated = true;
      return {
        async next() {
          if (finished) return { done: true, value: undefined };
          try {
            const result = await source.next();
            if (!result.done) {
              return {
                done: false,
                value: Buffer.isBuffer(result.value) ? result.value : Buffer.from(result.value),
              };
            }
            const [diagnostics, exit] = await Promise.all([stderr, child.exited]);
            finished = true;
            if (exit.code !== 0 || exit.signal !== null) throw helperError(diagnostics, exit);
            await verify();
            return { done: true, value: undefined };
          } catch (error) {
            await cancel();
            throw error;
          }
        },
        async return() {
          await cancel();
          return { done: true, value: undefined };
        },
        async throw(error) {
          await cancel();
          throw error;
        },
      };
    },
  };
}

async function terminate(child: WorkspaceHelperProcess): Promise<void> {
  child.kill("SIGTERM");
  let exit = await exitWithin(child.exited, PROCESS_STOP_TIMEOUT_MS);
  if (!exit) {
    child.kill("SIGKILL");
    exit = await exitWithin(child.exited, PROCESS_STOP_TIMEOUT_MS);
  }
  if (!exit) throw new Error("Workspace helper process did not exit after SIGKILL");
}

async function exitWithin(
  exited: WorkspaceHelperProcess["exited"],
  timeoutMs: number,
): Promise<Awaited<WorkspaceHelperProcess["exited"]> | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      exited,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function helperError(
  stderr: string,
  exit: { code: number | null; signal: NodeJS.Signals | null },
): Error {
  return new Error(stderr.trim() || `Workspace helper failed: ${exit.code ?? exit.signal}`);
}

function requireRelativePath(value: string): string {
  const segments = value.split(/[\\/]/u);
  if (
    !value ||
    value.startsWith("/") ||
    /^[A-Za-z]:\//u.test(value) ||
    value.includes("\\") ||
    segments.includes("..")
  ) {
    throw new Error(`Workspace helper path must be relative: ${value}`);
  }
  return value;
}

function subscriptionIncludesPath(
  input: LogicalWatchSubscription["input"],
  changedPath: string,
): boolean {
  if (input.ignoredPaths?.some((ignoredPath) => isPathInside(changedPath, ignoredPath))) {
    return false;
  }
  return input.paths.some(
    (watchedPath) =>
      changedPath === watchedPath ||
      (input.recursive === true && isPathInside(changedPath, watchedPath)),
  );
}

function isPathInside(candidate: string, directory: string): boolean {
  return directory === "." || candidate === directory || candidate.startsWith(`${directory}/`);
}

function onceDrain(stream: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once("drain", resolve);
    stream.once("error", reject);
  });
}

async function consumeLines(
  stream: NodeJS.ReadableStream,
  consume: (line: string) => void,
): Promise<void> {
  let buffered = "";
  for await (const chunk of stream) {
    buffered += chunk.toString();
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line) consume(line);
    }
  }
}
