import { sanitizeAgentMetrics } from "./agent-metrics.js";
import type {
  AgentClient,
  AgentMetric,
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
    persistence: canonicalImportPersistence(persistence, session),
    ...history,
  };
}

/**
 * Import handles identify a session by whatever the provider lists, which is not
 * always the session id: OMP lists session files. Persist the resumed session's own
 * identity instead, so records, dedupe and resume all agree, while the provider's
 * native handle still resolves the session.
 */
function canonicalImportPersistence(
  requested: AgentPersistenceHandle,
  session: ImportedProviderSession["session"],
): AgentPersistenceHandle {
  const described = session.describePersistence();
  if (!described?.sessionId) return requested;
  return {
    ...described,
    provider: requested.provider,
    nativeHandle: described.nativeHandle ?? requested.nativeHandle,
    metadata: { ...requested.metadata, ...described.metadata },
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

/** What an import keeps of a provider's replayed history, whichever way the events arrive. */
export class ImportedHistory {
  readonly timeline: ImportedTimelineEntry[] = [];
  readonly providerSubagentEvents: Extract<AgentStreamEvent, { type: "provider_subagent" }>[] = [];
  sessionMetrics: AgentMetric[] | undefined;

  add(event: AgentStreamEvent): void {
    switch (event.type) {
      case "provider_subagent":
        this.providerSubagentEvents.push(event);
        return;
      case "session_metrics_updated":
        this.sessionMetrics = sanitizeAgentMetrics(event.metrics);
        return;
      case "turn_completed": {
        const metrics = sanitizeAgentMetrics(event.metrics);
        const last = this.timeline.at(-1);
        if (last && metrics.length > 0) last.turnMetrics = metrics;
        return;
      }
      case "timeline":
        this.timeline.push({
          item: event.item,
          ...(event.timestamp ? { timestamp: event.timestamp } : {}),
        });
        return;
      default:
        return;
    }
  }

  result(): Pick<
    ImportedProviderSession,
    "timeline" | "sessionMetrics" | "providerSubagentEvents"
  > {
    return {
      timeline: this.timeline,
      ...(this.sessionMetrics ? { sessionMetrics: this.sessionMetrics } : {}),
      providerSubagentEvents: this.providerSubagentEvents,
    };
  }
}

async function collectImportedHistory(events: AsyncGenerator<AgentStreamEvent>) {
  const history = new ImportedHistory();
  for await (const event of events) history.add(event);
  return history.result();
}
