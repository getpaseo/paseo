import type {
  CreateAgentRequestOptions,
  CreateWorkspaceRequestOptions,
} from "@getpaseo/client/internal/daemon-client";
import { z } from "zod";
import {
  WorkspaceDescriptorPayloadSchema,
  CreationSnapshotSchema,
  UploadedFileAttachmentSchema,
  type UploadedFileAttachment,
  type CreationSnapshot,
  type AgentSnapshotPayload,
  type WorkspaceDescriptorPayload,
} from "@getpaseo/protocol/messages";
import { draftCreationKey } from "./creation-key";

interface Storage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

const AttemptSchema = z.object({
  kind: z.enum(["agent", "workspace"]),
  key: z.string(),
  outcome: z.enum(["pending", "failed", "unknown", "completed"]),
  revision: z.number().int().nonnegative(),
  error: z.string().nullable(),
  agentRequested: z.boolean().optional(),
});
type Attempt = z.infer<typeof AttemptSchema>;
const RecordSchema = z.object({
  attempt: AttemptSchema.nullable(),
  worktreeSlug: z.string().optional(),
  workspace: WorkspaceDescriptorPayloadSchema.optional(),
  workspacePlacementKey: z.string().optional(),
  agentIntentKey: z.string().optional(),
});
type Record = z.infer<typeof RecordSchema>;

function workspaceRequest(request: object): CreateWorkspaceRequestOptions {
  return ("request" in request ? request.request : request) as CreateWorkspaceRequestOptions;
}

function workspacePlacementKey(request: object): string {
  return draftCreationKey("workspace-placement", {
    source: workspaceRequest(request).source ?? null,
  });
}

interface Scope {
  key: string;
  record: Record;
  operation: Promise<void>;
  admission: Promise<void>;
  writes: Promise<void>;
}

interface Dependencies {
  storage: Storage;
  outcomeUnknownMessage: () => string;
  isNotSent: (error: unknown) => boolean;
  onPersistenceError: (error: unknown) => void;
}

interface Identity {
  serverId: string;
  draftId: string;
}

type ObserveCreation = (
  kind: CreationSnapshot["kind"],
  key: string,
  onEvent: (snapshot: CreationSnapshot) => void,
) => Promise<CreationSnapshot | null>;

interface WorkspaceRetryInput extends Identity {
  request: object;
  observe?: ObserveCreation;
}

type WorkspaceRetry =
  | { kind: "create" }
  | { kind: "replay" }
  | { kind: "reuse"; workspace: WorkspaceDescriptorPayload };

interface CreationOptions {
  idempotencyKey: string;
  onEvent: (snapshot: CreationSnapshot) => void;
}

interface Submission<Result> extends Identity {
  kind: Attempt["kind"];
  request: object;
  onEvent?: (snapshot: CreationSnapshot) => void;
  send: (options: CreationOptions) => Promise<Result>;
  onAdmitted?: () => Promise<void>;
}

interface SubmissionProgress {
  latest?: CreationSnapshot;
  observers: Set<(snapshot: CreationSnapshot) => void>;
}

function notifyObserver(
  observer: (snapshot: CreationSnapshot) => void,
  snapshot: CreationSnapshot,
) {
  try {
    observer(snapshot);
  } catch {
    // A progress consumer cannot control creation or other consumers' progress.
  }
}

function requestsAgent(input: Pick<Submission<unknown>, "kind" | "request">): boolean {
  return input.kind === "agent" || workspaceRequest(input.request).agent != null;
}

function isStandaloneReplay(attempt: Attempt, draftId: string, request: object): boolean {
  return attempt.kind === "agent" && attempt.key === draftCreationKey(draftId, request);
}

function receiptForWorkspaceRetry(record: Record, input: WorkspaceRetryInput): Attempt | undefined {
  const prior = record.attempt;
  if (
    !prior ||
    prior.outcome === "failed" ||
    prior.key === draftCreationKey(input.draftId, input.request)
  )
    return undefined;
  // Chat retries reconcile separately; cached readiness cannot settle a workspace-only retry.
  if (
    record.workspace &&
    (requestsAgent({ kind: "workspace", request: input.request }) ||
      prior.agentRequested === false ||
      (prior.outcome !== "pending" && prior.outcome !== "unknown"))
  )
    return undefined;
  if (!record.workspace && prior.kind !== "workspace") return undefined;
  return prior;
}

function canStartFirstAgent(
  previous: Record,
  input: Pick<Submission<unknown>, "kind" | "request">,
): boolean {
  return (
    previous.attempt?.kind === "workspace" &&
    previous.attempt.agentRequested === false &&
    input.kind === "agent" &&
    previous.workspace !== undefined &&
    "workspaceId" in input.request &&
    input.request.workspaceId === previous.workspace.id
  );
}

function agentIntent(request: object, root: string): string | undefined {
  const { workspaceId: _workspaceId, ...agent } = request as CreateAgentRequestOptions;
  if (!agent.config?.cwd) return undefined;
  const cwd = agent.config.cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  const base = root.replace(/\\/g, "/").replace(/\/+$/, "");
  if (cwd !== base && !cwd.startsWith(`${base}/`)) return undefined;
  return draftCreationKey("agent-intent", {
    ...agent,
    config: {
      ...agent.config,
      cwd: cwd.slice(base.length),
      providerOptions: agent.config.providerOptions ?? {},
    },
  });
}

function workspaceAgentIntent(request: object): string | undefined {
  const input = workspaceRequest(request);
  if (!input.agent || !input.source) return undefined;
  const root = input.source.kind === "directory" ? input.source.path : input.source.cwd;
  return root ? agentIntent(input.agent, root) : undefined;
}

export class DraftCreationOutcomeUnknownError extends Error {
  constructor(
    readonly previous: Attempt,
    message: string,
  ) {
    super(message);
    this.name = "DraftCreationOutcomeUnknownError";
  }
}

/** Admission blocks on storage; progress persistence never replaces the host's result. */
export function createDraftCreations(deps: Dependencies) {
  const scopes = new Map<string, Promise<Scope>>();
  const pendingImageUploads = new Map<string, Promise<UploadedFileAttachment>>();
  const inFlight = new Map<string, { result: Promise<unknown>; progress: SubmissionProgress }>();

  /** Upload handles are request identity: persist them before admitting a creation. */
  async function imageUpload(
    input: Identity & {
      image: object;
      upload: () => Promise<UploadedFileAttachment>;
    },
  ): Promise<UploadedFileAttachment> {
    const key = `draft-creation-image:${JSON.stringify([input.serverId, input.draftId, draftCreationKey("image", input.image)])}`;
    const existing = pendingImageUploads.get(key);
    if (existing) return existing;
    const pending = (async () => {
      const stored = await deps.storage.getItem(key);
      if (stored !== null) return UploadedFileAttachmentSchema.parse(JSON.parse(stored));
      const uploaded = await input.upload();
      await deps.storage.setItem(key, JSON.stringify(uploaded));
      return uploaded;
    })();
    pendingImageUploads.set(key, pending);
    try {
      return await pending;
    } finally {
      pendingImageUploads.delete(key);
    }
  }

  function scopeFor(identity: Identity): Promise<Scope> {
    const key = `draft-creation:${JSON.stringify([identity.serverId, identity.draftId])}`;
    const existing = scopes.get(key);
    if (existing) return existing;
    const loaded = deps.storage.getItem(key).then(
      (stored): Scope => ({
        key,
        record: stored === null ? { attempt: null } : RecordSchema.parse(JSON.parse(stored)),
        operation: Promise.resolve(),
        admission: Promise.resolve(),
        writes: Promise.resolve(),
      }),
    );
    scopes.set(key, loaded);
    void loaded.catch(() => scopes.delete(key));
    return loaded;
  }

  function serialize<Result>(
    scope: Scope,
    run: () => Promise<Result>,
    lock: "operation" | "admission" = "operation",
  ): Promise<Result> {
    const result = scope[lock].then(run);
    scope[lock] = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function checkpoint(scope: Scope, record: Record): void {
    scope.record = record;
    const serialized = JSON.stringify(record);
    scope.writes = scope.writes
      .then(() => deps.storage.setItem(scope.key, serialized))
      .catch(deps.onPersistenceError);
  }

  async function restore(scope: Scope, record: Record): Promise<void> {
    checkpoint(scope, record);
    await scope.writes;
  }

  function acceptSnapshot(
    scope: Scope,
    snapshot: CreationSnapshot,
    authoritative = false,
  ): boolean {
    const current = scope.record.attempt;
    if (!current) return false;
    const matches = snapshot.kind === current.kind && snapshot.idempotencyKey === current.key;
    const replayedFailure =
      current.outcome === "pending" &&
      snapshot.phase === "failed" &&
      snapshot.outcomeUnknown === false &&
      snapshot.revision === current.revision;
    if (
      !matches ||
      (!authoritative && snapshot.revision < current.revision) ||
      (!authoritative && replayedFailure)
    )
      return false;
    let outcome: Attempt["outcome"] = "pending";
    if (snapshot.phase === "completed") outcome = "completed";
    if (snapshot.phase === "failed") {
      outcome = snapshot.outcomeUnknown === false ? "failed" : "unknown";
    }
    checkpoint(scope, {
      ...scope.record,
      workspace: snapshot.workspace ?? scope.record.workspace,
      attempt: {
        kind: snapshot.kind,
        key: snapshot.idempotencyKey,
        outcome,
        revision: snapshot.revision,
        error: snapshot.error,
        agentRequested: current.agentRequested,
      },
    });
    return true;
  }

  async function worktreeSlug(input: Identity & { proposed: string }): Promise<string> {
    const scope = await scopeFor(input);
    // A durable slug remains readable while its creation is in flight.
    if (scope.record.worktreeSlug) return scope.record.worktreeSlug;
    return serialize(scope, async () => {
      if (scope.record.worktreeSlug) return scope.record.worktreeSlug;
      const record = { ...scope.record, worktreeSlug: input.proposed };
      await deps.storage.setItem(scope.key, JSON.stringify(record));
      scope.record = record;
      return input.proposed;
    });
  }

  async function workspaceRetry(input: WorkspaceRetryInput): Promise<WorkspaceRetry> {
    const scope = await scopeFor(input);
    await scope.writes;
    const observe = input.observe;
    // Identical retries must reach the in-flight coalescer without waiting on observation.
    if (observe && receiptForWorkspaceRetry(scope.record, input)) {
      await serialize(scope, async () => {
        await scope.writes;
        const prior = receiptForWorkspaceRetry(scope.record, input);
        if (!prior) return;
        const snapshot = await observe(prior.kind, prior.key, (update) =>
          acceptSnapshot(scope, update, true),
        );
        await scope.writes;
        if (snapshot?.kind !== prior.kind || snapshot.idempotencyKey !== prior.key)
          throw new DraftCreationOutcomeUnknownError(prior, deps.outcomeUnknownMessage());
        const conclusiveFailure = snapshot.phase === "failed" && snapshot.outcomeUnknown === false;
        if (!scope.record.workspace && !conclusiveFailure)
          throw new DraftCreationOutcomeUnknownError(prior, deps.outcomeUnknownMessage());
      });
    }
    if (!scope.record.workspace) return { kind: "create" };
    const prior = scope.record.attempt;
    const sameRequest =
      prior?.kind === "workspace" && prior.key === draftCreationKey(input.draftId, input.request);
    if (sameRequest) return { kind: "replay" };
    // A terminal/empty launch would retire the draft ID on success. It must not
    // detach saved chat content from an agent whose outcome is still unresolved.
    const workspaceOnly = !requestsAgent({ kind: "workspace", request: input.request });
    if (
      workspaceOnly &&
      prior?.agentRequested !== false &&
      (prior?.outcome === "pending" || prior?.outcome === "unknown")
    ) {
      throw new DraftCreationOutcomeUnknownError(prior, deps.outcomeUnknownMessage());
    }
    if (scope.record.workspacePlacementKey !== workspacePlacementKey(input.request)) {
      throw new Error(
        "Workspace placement has changed. Restore the original project, branch, and isolation, or open a new draft.",
      );
    }
    return { kind: "reuse", workspace: scope.record.workspace };
  }

  async function reconcileWorkspace(
    input: Identity & {
      workspaceId: string;
      request: object;
      observe: ObserveCreation;
    },
  ): Promise<AgentSnapshotPayload | undefined> {
    const scope = await scopeFor(input);
    return serialize(scope, async () => {
      await scope.writes;
      const prior = scope.record.attempt;
      if (
        !prior ||
        prior.agentRequested === false ||
        prior.outcome === "failed" ||
        isStandaloneReplay(prior, input.draftId, input.request)
      )
        return undefined;
      const snapshot = await input.observe(prior.kind, prior.key, (update) =>
        acceptSnapshot(scope, update, true),
      );
      await scope.writes;
      if (snapshot?.kind !== prior.kind || snapshot.idempotencyKey !== prior.key)
        throw new DraftCreationOutcomeUnknownError(prior, deps.outcomeUnknownMessage());
      const ready = scope.record.workspace;
      if (prior.kind === "workspace" && (!ready || ready.id !== input.workspaceId))
        throw new DraftCreationOutcomeUnknownError(prior, deps.outcomeUnknownMessage());
      if (snapshot.phase === "failed" && snapshot.outcomeUnknown === false) return undefined;
      if (
        snapshot.phase === "completed" &&
        snapshot.agent &&
        prior.kind === "workspace" &&
        ready !== undefined &&
        scope.record.agentIntentKey !== undefined &&
        scope.record.agentIntentKey === agentIntent(input.request, ready.workspaceDirectory)
      )
        return snapshot.agent;
      throw new DraftCreationOutcomeUnknownError(
        scope.record.attempt ?? prior,
        deps.outcomeUnknownMessage(),
      );
    });
  }

  async function retireWorkspace(
    input: Identity & { workspaceId: string; retire: () => void },
  ): Promise<boolean> {
    const scope = await scopeFor(input);
    return serialize(
      scope,
      async () => {
        await scope.writes;
        const prior = scope.record.attempt;
        // A retained workspace with no attempt is the legacy agent-not-sent rollback.
        const noAgentStart = prior
          ? (prior.kind === "workspace" && prior.agentRequested === false) ||
            prior.outcome === "failed"
          : scope.record.workspace !== undefined;
        if (!noAgentStart || scope.record.workspace?.id !== input.workspaceId) return false;
        input.retire();
        return true;
      },
      "admission",
    );
  }

  async function submit<Result>(input: Submission<Result>): Promise<Result> {
    const scope = await scopeFor(input);
    const key = draftCreationKey(input.draftId, input.request);
    const identity = JSON.stringify([scope.key, input.kind, key]);
    const pending = inFlight.get(identity);
    if (pending) {
      if (input.onEvent) {
        pending.progress.observers.add(input.onEvent);
        if (pending.progress.latest) notifyObserver(input.onEvent, pending.progress.latest);
      }
      return pending.result as Promise<Result>;
    }
    const progress: SubmissionProgress = {
      observers: new Set(input.onEvent ? [input.onEvent] : []),
    };
    const result = executeSubmission(scope, input, key, (snapshot) => {
      progress.latest = snapshot;
      for (const observer of progress.observers) notifyObserver(observer, snapshot);
    });
    inFlight.set(identity, { result, progress });
    const release = () => {
      if (inFlight.get(identity)?.result === result) inFlight.delete(identity);
    };
    void result.then(release, release);
    return result;
  }

  async function executeSubmission<Result>(
    scope: Scope,
    input: Submission<Result>,
    key: string,
    notify: (snapshot: CreationSnapshot) => void,
  ): Promise<Result> {
    return serialize(scope, async () => {
      const admitted = await serialize(
        scope,
        async () => {
          await scope.writes;
          const previous = scope.record;
          const prior = previous.attempt;
          const sameRequest = prior?.key === key && prior.kind === input.kind;
          const firstAgentInReadyWorkspace = canStartFirstAgent(previous, input);
          if (prior && prior.outcome !== "failed" && !sameRequest && !firstAgentInReadyWorkspace) {
            throw new DraftCreationOutcomeUnknownError(prior, deps.outcomeUnknownMessage());
          }
          await input.onAdmitted?.();
          const revision = sameRequest ? prior.revision : 0;
          const attempt: Attempt = {
            kind: input.kind,
            key,
            outcome: "pending",
            revision,
            error: null,
            agentRequested: requestsAgent(input),
          };
          const pending = {
            ...previous,
            attempt,
            ...(input.kind === "workspace"
              ? {
                  workspacePlacementKey: workspacePlacementKey(input.request),
                  agentIntentKey: workspaceAgentIntent(input.request),
                }
              : {}),
          };
          try {
            await deps.storage.setItem(scope.key, JSON.stringify(pending));
          } catch (error) {
            // A rejected storage write may have committed. Undo it before allowing an edited retry.
            await restore(scope, previous);
            throw error;
          }
          scope.record = pending;

          return { previous, key };
        },
        "admission",
      );

      const onEvent = (snapshot: CreationSnapshot) => {
        if (acceptSnapshot(scope, snapshot)) notify(snapshot);
      };

      try {
        const result = await input.send({ idempotencyKey: admitted.key, onEvent });
        if (result && typeof result === "object" && "creation" in result) {
          const snapshot = CreationSnapshotSchema.safeParse(result.creation);
          if (snapshot.success) acceptSnapshot(scope, snapshot.data, true);
        }
        return result;
      } catch (error) {
        if (deps.isNotSent(error)) {
          // Legacy workspace creation sends the agent separately. Its local rejection cannot
          // undo a confirmed workspace, and the next retry must skip provisioning entirely.
          const stagedWorkspace = scope.record.workspace && !admitted.previous.workspace;
          await restore(
            scope,
            stagedWorkspace ? { ...scope.record, attempt: null } : admitted.previous,
          );
        }
        throw error;
      } finally {
        await scope.writes;
      }
    });
  }

  return { submit, worktreeSlug, workspaceRetry, reconcileWorkspace, retireWorkspace, imageUpload };
}
