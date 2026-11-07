import {
  negotiateProviderCapabilities,
  requireProviderCapabilities,
  type ProviderCatalog,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  type ProviderLaunch,
  type ProviderRegistration,
} from "@getpaseo/plugin/server/provider";
import { getCatalog, getStatus, launchCacheKey } from "./internal/catalog.js";
import { Session } from "./internal/session.js";
import { AntigravityError } from "./internal/wire.js";

const capabilities = [
  "prompt.message",
  "prompt.image",
  "session.configure",
  "session.persistence",
] as const;

export function createAntigravityProvider(): ProviderRegistration {
  return {
    id: "antigravity",
    label: "Antigravity",
    icon: "icon.svg",
    command: ["agy"],
    description: "Antigravity CLI on your host",
    async status({ launch }) {
      if (!launch)
        return {
          available: false,
          diagnostic: "agy not found on PATH. Install Antigravity, then run `agy` and sign in.",
        };
      return getStatus(launch);
    },
    async getCatalogCacheKey({ launch }) {
      if (!launch) return undefined;
      return launchCacheKey(launch);
    },
    async connect(request) {
      if (!request.versions.includes(1))
        throw new AntigravityError("Provider protocol version 1 is required");
      if (!request.launch)
        throw new AntigravityError("The daemon must supply the Antigravity launch");
      const negotiated = negotiateProviderCapabilities(request.capabilities, capabilities);
      return createConnection(request.launch, negotiated);
    },
  };
}

function createConnection(
  launch: ProviderLaunch,
  negotiated: readonly string[],
): ProviderConnection {
  const sessions = new Map<string, Session>();
  const listeners = new Set<(event: ProviderEvent) => void>();
  const sessionQueues = new Map<string, Promise<void>>();
  const inFlight = new Set<Promise<void>>();
  let discovered: ProviderCatalog | null = null;
  let discovering: Promise<ProviderCatalog> | null = null;
  let closed = false;

  function emit(event: ProviderEvent): void {
    if (closed) return;
    for (const listener of listeners) listener(event);
  }
  function catalog(): ProviderCatalog {
    if (discovered === null)
      throw new AntigravityError("Antigravity catalog has not been discovered");
    return discovered;
  }
  async function ensureCatalog(cwd?: string, refresh = false): Promise<ProviderCatalog> {
    if (!refresh && discovered !== null) return discovered;
    if (!refresh && discovering !== null) return discovering;
    const task = getCatalog(launch, cwd, { refresh })
      .then((result) => {
        discovered = result;
        return result;
      })
      .finally(() => {
        if (discovering === task) discovering = null;
      });
    discovering = task;
    return task;
  }
  function session(id: string): Session {
    const found = sessions.get(id);
    if (!found) throw new AntigravityError(`Unknown Antigravity session: ${id}`);
    return found;
  }
  async function dispatch(input: ProviderInput): Promise<void> {
    switch (input.type) {
      case "catalog":
        await ensureCatalog(input.cwd, discovered !== null);
        emit({
          type: "catalog",
          requestId: input.requestId,
          catalog: catalog(),
        });
        return;
      case "session.open": {
        if (sessions.has(input.sessionId))
          throw new AntigravityError(`Session already exists: ${input.sessionId}`);
        await ensureCatalog(input.config.cwd, false);
        const opened = new Session({
          id: input.sessionId,
          config: input.config,
          persistence: input.persistence,
          catalog,
          launch,
          emit,
        });
        sessions.set(input.sessionId, opened);
        try {
          await opened.open(input.requestId, negotiated, input.history);
        } catch (error) {
          sessions.delete(input.sessionId);
          await opened.close();
          throw error;
        }
        return;
      }
      case "session.prompt":
        await session(input.sessionId).prompt(input.prompt);
        return;
      case "session.configure":
        session(input.sessionId).configure(input.changes);
        break;
      case "session.interrupt":
        await session(input.sessionId).interrupt();
        break;
      case "session.close": {
        await session(input.sessionId).close();
        sessions.delete(input.sessionId);
        emit({ type: "session.closed", sessionId: input.sessionId });
        break;
      }
      default:
        throw new AntigravityError(`Unsupported Antigravity operation: ${input.type}`);
    }
    emit({ type: "request.completed", requestId: input.requestId });
  }
  function failed(input: ProviderInput, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof AntigravityError ? error.code : "ANTIGRAVITY_ERROR";
    if (input.type === "session.prompt")
      emit({
        type: "session.prompt_result",
        sessionId: input.sessionId,
        clientMessageId: input.prompt.clientMessageId,
        result: { type: "failed", error: { message, code } },
      });
    else if ("requestId" in input)
      emit({ type: "request.failed", requestId: input.requestId, error: { message, code } });
  }
  return {
    version: 1,
    capabilities: negotiated,
    async send(input) {
      if (closed) throw new AntigravityError("Antigravity connection is closed");
      requireProviderCapabilities(negotiated, input);
      const key = "sessionId" in input ? input.sessionId : "__catalog__";
      const previous = sessionQueues.get(key) ?? Promise.resolve();
      const current = previous
        .then(async () => {
          if (!closed) await dispatch(input);
          return undefined;
        })
        .catch((error) => failed(input, error))
        .finally(() => {
          inFlight.delete(current);
          if (sessionQueues.get(key) === current) {
            sessionQueues.delete(key);
          }
        });
      sessionQueues.set(key, current);
      inFlight.add(current);
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      if (closed) return;
      closed = true;
      await Promise.allSettled(inFlight);
      await Promise.all([...sessions.values()].map((opened) => opened.close()));
      sessions.clear();
      sessionQueues.clear();
      listeners.clear();
    },
  };
}
