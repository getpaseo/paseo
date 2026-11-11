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
import { Session } from "./internal/session.js";
import { AntigravityError } from "./internal/wire.js";
import type { Usage } from "./usage.js";

const capabilities = [
  "prompt.message",
  "prompt.command",
  "prompt.image",
  "session.can_stop_runtime",
  "session.configure",
  "session.persistence",
  "session.subsession",
  "permission",
] as const;

export function createAntigravityProvider(usage?: Usage): ProviderRegistration {
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
      usage?.rememberLaunch(launch);
      return getStatus(launch);
    },
    async getCatalogCacheKey({ launch }) {
      if (!launch) return undefined;
      const env = Object.entries(launch.env).sort(([left], [right]) => left.localeCompare(right));
      return createHash("sha256")
        .update(JSON.stringify([launch.command, launch.args, env]))
        .digest("hex");
    },
    async connect(request) {
      if (!request.versions.includes(1))
        throw new AntigravityError(
          "Provider protocol version 1 is required",
          "UNSUPPORTED_VERSION",
        );
      if (!request.launch)
        throw new AntigravityError(
          "The daemon must supply the Antigravity launch",
          "MISSING_LAUNCH",
        );
      usage?.rememberLaunch(request.launch);
      const negotiated = negotiateProviderCapabilities(request.capabilities, capabilities);
      return createConnection(request.launch, negotiated, usage);
    },
  };
}

function createConnection(
  launch: ProviderLaunch,
  negotiated: readonly string[],
  usage?: Usage,
): ProviderConnection {
  const sessions = new Map<string, Session>();
  const sessionQueues = new Map<string, Promise<void>>();
  const inFlight = new Set<Promise<void>>();
  const listeners = new Set<(event: ProviderEvent) => void>();
  let discovered: ProviderCatalog | null = null;
  let catalogPromise: Promise<ProviderCatalog> | null = null;
  let closed = false;

  function emit(event: ProviderEvent): void {
    if (closed) return;
    for (const listener of listeners) listener(event);
  }
  function catalog(): ProviderCatalog {
    if (discovered === null)
      throw new AntigravityError("Antigravity catalog has not been discovered", "MISSING_CATALOG");
    return discovered;
  }
  async function ensureCatalog(cwd?: string, forceRefresh = false): Promise<ProviderCatalog> {
    if (!forceRefresh && discovered !== null) return discovered;
    if (!forceRefresh && catalogPromise) return catalogPromise;
    const request = getCatalog(launch, cwd).then((next) => {
      discovered = next;
      return next;
    });
    catalogPromise = request;
    try {
      return await request;
    } finally {
      if (catalogPromise === request) catalogPromise = null;
    }
  }
  async function resolveSession(id: string): Promise<Session> {
    const immediate = sessions.get(id);
    if (immediate) return immediate;
    const pendingQueue = sessionQueues.get(id);
    if (pendingQueue) await pendingQueue;
    const afterQueue = sessions.get(id);
    if (!afterQueue)
      throw new AntigravityError(`Unknown Antigravity session: ${id}`, "UNKNOWN_SESSION");
    return afterQueue;
  }
  async function openSession(
    input: Extract<ProviderInput, { type: "session.open" }>,
  ): Promise<void> {
    if (sessions.has(input.sessionId))
      throw new AntigravityError(`Session already exists: ${input.sessionId}`, "DUPLICATE_SESSION");
    await ensureCatalog(input.config.cwd);
    if (sessions.has(input.sessionId))
      throw new AntigravityError(`Session already exists: ${input.sessionId}`, "DUPLICATE_SESSION");
    const opened = new Session({
      id: input.sessionId,
      config: input.config,
      persistence: input.persistence,
      history: input.history,
      catalog,
      launch,
      emit,
      usage,
    });
    sessions.set(input.sessionId, opened);
    try {
      await opened.open(input.requestId, negotiated);
    } catch (error) {
      sessions.delete(input.sessionId);
      await opened.close();
      throw error;
    }
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
      case "session.can_stop_runtime":
        emit({
          type: "session.can_stop_runtime",
          requestId: input.requestId,
          sessionId: input.sessionId,
          canStop: (await resolveSession(input.sessionId)).canStopRuntime(),
        });
        return;
      case "session.open":
        await openSession(input);
        return;
      case "session.prompt":
        await (await resolveSession(input.sessionId)).prompt(input.prompt);
        return;
      case "session.permission":
        (await resolveSession(input.sessionId)).respondToPermission(
          input.permissionId,
          input.response,
        );
        return;
      case "session.configure":
        await (await resolveSession(input.sessionId)).configure(input.changes);
        break;
      case "session.interrupt":
        await (await resolveSession(input.sessionId)).interrupt();
        break;
      case "session.close": {
        const target = await resolveSession(input.sessionId);
        sessions.delete(input.sessionId);
        sessionQueues.delete(input.sessionId);
        await target.close();
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
  function trackTask(task: Promise<void>): void {
    inFlight.add(task);
    void task.finally(() => {
      inFlight.delete(task);
    });
  }
  function scheduleInput(input: ProviderInput): void {
    const serializedForSession =
      input.type === "session.open" ||
      input.type === "session.configure" ||
      input.type === "session.prompt";
    if (!serializedForSession) {
      trackTask(
        Promise.resolve()
          .then(async () => {
            if (!closed) await dispatch(input);
            return undefined;
          })
          .catch((error) => failed(input, error)),
      );
      return;
    }
    const previous = sessionQueues.get(input.sessionId) ?? Promise.resolve();
    const next = previous
      .then(async () => {
        if (!closed) await dispatch(input);
        return undefined;
      })
      .catch((error) => failed(input, error));
    sessionQueues.set(input.sessionId, next);
    trackTask(
      next.finally(() => {
        if (sessionQueues.get(input.sessionId) === next) {
          sessionQueues.delete(input.sessionId);
        }
      }),
    );
  }
  return {
    version: 1,
    capabilities: negotiated,
    async send(input) {
      if (closed) throw new AntigravityError("Antigravity connection is closed", "CLOSED");
      requireProviderCapabilities(negotiated, input);
      scheduleInput(input);
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
