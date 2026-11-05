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
  const session = await input.resumeSession(persistence, config, input.context.launchContext);
  const history = await collectImportedHistory(session.streamHistory());

  return {
    session,
    config: storedConfig,
    persistence,
    timeline: history.timeline,
    providerSubagentEvents: history.providerSubagentEvents,
  };
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

async function collectImportedHistory(events: AsyncGenerator<AgentStreamEvent>): Promise<{
  timeline: ImportedTimelineEntry[];
  providerSubagentEvents: Extract<AgentStreamEvent, { type: "provider_subagent" }>[];
}> {
  const timeline: ImportedTimelineEntry[] = [];
  const providerSubagentEvents: Extract<AgentStreamEvent, { type: "provider_subagent" }>[] = [];
  for await (const event of events) {
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
  return { timeline, providerSubagentEvents };
}
