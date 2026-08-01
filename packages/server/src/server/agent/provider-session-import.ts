import type {
  AgentClient,
  AgentPersistenceHandle,
  AgentProvider,
  AgentSessionConfig,
  AgentStreamEvent,
  ImportedProviderSession,
  ImportedTimelineEntry,
  ImportProviderSessionContext,
  ImportProviderSessionInput,
} from "./agent-sdk-types.js";

export async function importSessionFromPersistence(input: {
  provider: AgentProvider;
  request: ImportProviderSessionInput;
  context: ImportProviderSessionContext;
  resumeSession: AgentClient["resumeSession"];
  config?: Partial<AgentSessionConfig>;
  persistence?: AgentPersistenceHandle;
}): Promise<ImportedProviderSession> {
  const config = {
    ...input.context.config,
    ...input.config,
    provider: input.provider,
    cwd: input.request.cwd,
  } as AgentSessionConfig;
  const storedConfig = {
    ...input.context.storedConfig,
    ...input.config,
    provider: input.provider,
    cwd: input.request.cwd,
  } as AgentSessionConfig;
  const persistence =
    input.persistence ?? buildImportPersistenceHandle(input.provider, input.request, storedConfig);
  input.context.signal?.throwIfAborted();
  const session = await input.resumeSession(persistence, config, input.context.launchContext, {
    signal: input.context.signal,
  });

  try {
    const history = await collectImportedHistory(
      session.streamHistory(input.context.signal),
      input.context.signal,
    );

    return {
      session,
      config: storedConfig,
      persistence,
      timeline: history.timeline,
      providerSubagentEvents: history.providerSubagentEvents,
    };
  } catch (error) {
    try {
      await session.close();
    } catch {
      // Preserve the import failure that caused this unregistered session to be closed.
    }
    throw error;
  }
}

function buildImportPersistenceHandle(
  provider: AgentProvider,
  input: ImportProviderSessionInput,
  config: AgentSessionConfig,
): AgentPersistenceHandle {
  return {
    provider,
    sessionId: input.providerHandleId,
    nativeHandle: input.providerHandleId,
    metadata: {
      ...config,
      provider,
      cwd: input.cwd,
    },
  };
}

async function collectImportedHistory(
  events: AsyncGenerator<AgentStreamEvent>,
  signal?: AbortSignal,
): Promise<{
  timeline: ImportedTimelineEntry[];
  providerSubagentEvents: Extract<AgentStreamEvent, { type: "provider_subagent" }>[];
}> {
  const timeline: ImportedTimelineEntry[] = [];
  const providerSubagentEvents: Extract<AgentStreamEvent, { type: "provider_subagent" }>[] = [];
  const iterator = events[Symbol.asyncIterator]();
  while (true) {
    signal?.throwIfAborted();
    const result = await waitForImportOperationOrAbort(iterator.next(), signal);
    if (result.done) {
      break;
    }
    const event = result.value;
    if (event.type === "provider_subagent") {
      providerSubagentEvents.push(event);
      continue;
    }
    if (event.type !== "timeline") {
      continue;
    }
    timeline.push({
      item: event.item,
      ...(event.timestamp ? { timestamp: event.timestamp } : {}),
    });
  }
  signal?.throwIfAborted();
  return { timeline, providerSubagentEvents };
}

async function waitForImportOperationOrAbort<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) {
    return await operation;
  }
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        return resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        return reject(error);
      },
    );
  });
}
