import { createHash } from "node:crypto";
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
import { getCatalog, getStatus } from "./internal/catalog.js";
import { Session, toProviderError } from "./internal/session.js";
import { Sessions } from "./internal/sessions.js";
import { Usage } from "./internal/usage.js";
import { AntigravityError } from "./internal/wire.js";

const capabilities = [
  "prompt.message",
  "prompt.command",
  "prompt.image",
  "session.can_stop_runtime",
  "session.configure",
  "session.list",
  "session.persistence",
  "permission",
  "permission.tool_policy",
] as const;

export function createAntigravityProvider(usage = new Usage()): ProviderRegistration {
  return {
    id: "antigravity",
    label: "Antigravity",
    icon: "icon.svg",
    command: ["agy"],
    description: "Antigravity CLI on your host",
    async status({ launch }) {
      if (!launch) {
        return {
          available: false,
          diagnostic: "agy not found on PATH. Install Antigravity, then run `agy` and sign in.",
        };
      }
      const result = await getStatus(launch);
      if (result.available) {
        usage.remember(launch);
      }
      return result;
    },
    async getCatalogCacheKey({ launch }) {
      if (!launch) return undefined;
      const env = Object.entries(launch.env).sort(([left], [right]) => left.localeCompare(right));
      return createHash("sha256")
        .update(JSON.stringify([launch.command, launch.args, env]))
        .digest("hex");
    },
    async connect(request) {
      if (!request.versions.includes(1)) {
        throw new AntigravityError(
          "Provider protocol version 1 is required",
          "UNSUPPORTED_VERSION",
        );
      }
      if (!request.launch) {
        throw new AntigravityError(
          "The daemon must supply the Antigravity launch",
          "MISSING_LAUNCH",
        );
      }
      usage.remember(request.launch);
      const negotiated = negotiateProviderCapabilities(request.capabilities, capabilities);
      return createConnection(request.launch, negotiated, usage);
    },
  };
}

function createConnection(
  launch: ProviderLaunch,
  negotiated: readonly string[],
  usage: Usage,
): ProviderConnection {
  const sessions = new Map<string, Session>();
  const imports = new Sessions();
  const listeners = new Set<(event: ProviderEvent) => void>();
  const inFlight = new Set<Promise<void>>();
  let discovered: ProviderCatalog | null = null;
  let catalogInFlight: Promise<ProviderCatalog> | null = null;
  let closed = false;

  function emit(event: ProviderEvent): void {
    if (closed) return;
    for (const listener of listeners) listener(event);
  }

  function catalog(): ProviderCatalog {
    if (discovered === null) {
      throw new AntigravityError("Antigravity catalog has not been discovered", "MISSING_CATALOG");
    }
    return discovered;
  }

  async function ensureCatalog(cwd?: string, force = false): Promise<ProviderCatalog> {
    if (!force && discovered !== null) return discovered;
    if (!force && catalogInFlight !== null) return catalogInFlight;
    const promise = getCatalog(launch, cwd)
      .then((result) => {
        discovered = result;
        return result;
      })
      .finally(() => {
        if (catalogInFlight === promise) catalogInFlight = null;
      });
    catalogInFlight = promise;
    return promise;
  }

  function session(id: string): Session {
    const found = sessions.get(id);
    if (!found) throw new AntigravityError(`Unknown Antigravity session: ${id}`, "UNKNOWN_SESSION");
    return found;
  }

  async function dispatch(input: ProviderInput): Promise<void> {
    switch (input.type) {
      case "catalog":
        emit({
          type: "catalog",
          requestId: input.requestId,
          catalog: await ensureCatalog(input.cwd, true),
        });
        return;
      case "sessions":
        emit({
          type: "sessions",
          requestId: input.requestId,
          sessions: await imports.list(launch, input),
        });
        return;
      case "session.open": {
        if (sessions.has(input.sessionId)) {
          throw new AntigravityError(
            `Session already exists: ${input.sessionId}`,
            "DUPLICATE_SESSION",
          );
        }
        await ensureCatalog(input.config.cwd);
        if (closed) {
          throw new AntigravityError("Antigravity connection is closed", "CLOSED");
        }
        const sessionLaunch: ProviderLaunch = {
          ...launch,
          env: { ...launch.env, ...input.config.env },
        };
        const opened = new Session({
          id: input.sessionId,
          config: input.config,
          persistence: input.persistence,
          catalog,
          launch,
          emit,
          onTierObserved: (tierName) => usage.recordTier(sessionLaunch, tierName),
        });
        sessions.set(input.sessionId, opened);
        try {
          await opened.open(input.requestId, negotiated, input.history);
          if (closed) {
            throw new AntigravityError("Antigravity connection is closed", "CLOSED");
          }
          usage.remember(sessionLaunch);
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
      case "session.permission":
        session(input.sessionId).respondToPermission(input.permissionId, input.response);
        return;
      case "session.can_stop_runtime":
        emit({
          type: "session.can_stop_runtime",
          requestId: input.requestId,
          sessionId: input.sessionId,
          canStop: session(input.sessionId).canStopRuntime(),
        });
        return;
      case "session.configure":
        await session(input.sessionId).configure(input.changes);
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
        throw new AntigravityError(
          `Unsupported Antigravity operation: ${input.type}`,
          "UNSUPPORTED_OPERATION",
        );
    }
    emit({ type: "request.completed", requestId: input.requestId });
  }

  function failed(input: ProviderInput, failure: unknown): void {
    const error = toProviderError(failure);
    if (input.type === "session.prompt") {
      emit({
        type: "session.prompt_result",
        sessionId: input.sessionId,
        clientMessageId: input.prompt.clientMessageId,
        result: { type: "failed", error },
      });
    } else if ("requestId" in input) {
      emit({ type: "request.failed", requestId: input.requestId, error });
    } else if ("sessionId" in input) {
      emit({ type: "session.runtime_failed", sessionId: input.sessionId, error });
    }
  }

  return {
    version: 1,
    capabilities: negotiated,
    async send(input) {
      if (closed) throw new AntigravityError("Antigravity connection is closed", "CLOSED");
      requireProviderCapabilities(negotiated, input);
      queueMicrotask(() => {
        if (closed) return;
        const task = dispatch(input)
          .catch((error: unknown) => failed(input, error))
          .finally(() => {
            inFlight.delete(task);
          });
        inFlight.add(task);
      });
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      if (closed) return;
      closed = true;
      await Promise.all([
        imports.close(),
        ...[...sessions.values()].map((opened) => opened.close()),
        Promise.allSettled(inFlight),
      ]);
      await Promise.all([
        imports.close(),
        ...[...sessions.values()].map((opened) => opened.close()),
      ]);
      sessions.clear();
      listeners.clear();
    },
  };
}
