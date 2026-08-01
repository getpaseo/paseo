import { expect, test } from "vitest";

import type {
  AgentClient,
  AgentResumeSessionOptions,
  AgentSession,
  AgentStreamEvent,
  ImportProviderSessionContext,
} from "./agent-sdk-types.js";
import { importSessionFromPersistence } from "./provider-session-import.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createContext(signal?: AbortSignal): ImportProviderSessionContext {
  return {
    config: { provider: "codex", cwd: "/workspace/repo" },
    storedConfig: { provider: "codex", cwd: "/workspace/repo" },
    signal,
  };
}

function createImportSession(input: {
  streamHistory: (signal?: AbortSignal) => AsyncGenerator<AgentStreamEvent>;
  close: () => Promise<void>;
}): AgentSession {
  return input as AgentSession;
}

function importSession(input: {
  context: ImportProviderSessionContext;
  resumeSession: AgentClient["resumeSession"];
}) {
  return importSessionFromPersistence({
    provider: "codex",
    request: { providerHandleId: "thread-selected", cwd: "/workspace/repo" },
    context: input.context,
    resumeSession: input.resumeSession,
  });
}

test("does not resume an import whose cancellation signal is already aborted", async () => {
  const controller = new AbortController();
  const cancellation = new Error("cancel before import resume");
  let resumeCalled = false;
  controller.abort(cancellation);

  const importing = importSession({
    context: createContext(controller.signal),
    resumeSession: async () => {
      resumeCalled = true;
      throw new Error("unexpected resume");
    },
  });

  await expect(importing).rejects.toBe(cancellation);
  expect(resumeCalled).toBe(false);
});

test("closes an unregistered resumed session and preserves the history failure", async () => {
  const historyFailure = new Error("provider history failed");
  const closeFailure = new Error("provider close failed");
  let closeCalls = 0;
  const session = createImportSession({
    streamHistory: async function* () {
      yield* [];
      throw historyFailure;
    },
    close: async () => {
      closeCalls += 1;
      throw closeFailure;
    },
  });

  const importing = importSession({
    context: createContext(),
    resumeSession: async () => session,
  });

  await expect(importing).rejects.toBe(historyFailure);
  expect(closeCalls).toBe(1);
});

test("cancels history collection, closes the session, and passes the signal to resume", async () => {
  const controller = new AbortController();
  const cancellation = new Error("cancel provider history");
  const historyStarted = deferred<void>();
  let closeCalls = 0;
  let historySignal: AbortSignal | undefined;
  let resumeOptions: AgentResumeSessionOptions | undefined;
  const session = createImportSession({
    streamHistory: async function* (signal) {
      historySignal = signal;
      historyStarted.resolve();
      await new Promise<never>(() => {});
      yield* [];
    },
    close: async () => {
      closeCalls += 1;
    },
  });
  const importing = importSession({
    context: createContext(controller.signal),
    resumeSession: async (_handle, _config, _launchContext, options) => {
      resumeOptions = options;
      return session;
    },
  });
  await historyStarted.promise;
  const rejectedImport = expect(importing).rejects.toBe(cancellation);

  controller.abort(cancellation);

  await rejectedImport;
  expect(resumeOptions).toEqual({ signal: controller.signal });
  expect(historySignal).toBe(controller.signal);
  expect(closeCalls).toBe(1);
});
