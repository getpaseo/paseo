import { z } from "zod";
import type { CreationSnapshot } from "@getpaseo/protocol/messages";
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
});
type Attempt = z.infer<typeof AttemptSchema>;
const RecordSchema = z.object({
  attempt: AttemptSchema.nullable(),
  worktreeSlug: z.string().optional(),
});
type Record = z.infer<typeof RecordSchema>;

interface Scope {
  key: string;
  record: Record;
  operation: Promise<void>;
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

interface CreationOptions {
  idempotencyKey: string;
  onEvent: (snapshot: CreationSnapshot) => void;
}

interface Submission<Result> extends Identity {
  kind: Attempt["kind"];
  request: object;
  onEvent?: (snapshot: CreationSnapshot) => void;
  send: (options: CreationOptions) => Promise<Result>;
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

  function scopeFor(identity: Identity): Promise<Scope> {
    const key = `draft-creation:${JSON.stringify([identity.serverId, identity.draftId])}`;
    const existing = scopes.get(key);
    if (existing) return existing;
    const loaded = deps.storage.getItem(key).then(
      (stored): Scope => ({
        key,
        record: stored === null ? { attempt: null } : RecordSchema.parse(JSON.parse(stored)),
        operation: Promise.resolve(),
        writes: Promise.resolve(),
      }),
    );
    scopes.set(key, loaded);
    void loaded.catch(() => scopes.delete(key));
    return loaded;
  }

  function serialize<Result>(scope: Scope, run: () => Promise<Result>): Promise<Result> {
    const result = scope.operation.then(run);
    scope.operation = result.then(
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

  async function worktreeSlug(input: Identity & { proposed: string }): Promise<string> {
    const scope = await scopeFor(input);
    return serialize(scope, async () => {
      if (scope.record.worktreeSlug) return scope.record.worktreeSlug;
      const record = { ...scope.record, worktreeSlug: input.proposed };
      await deps.storage.setItem(scope.key, JSON.stringify(record));
      scope.record = record;
      return input.proposed;
    });
  }

  async function submit<Result>(input: Submission<Result>): Promise<Result> {
    const scope = await scopeFor(input);
    return serialize(scope, async () => {
      await scope.writes;
      const previous = scope.record;
      const key = draftCreationKey(input.draftId, input.request);
      const prior = previous.attempt;
      const sameRequest = prior?.key === key && prior.kind === input.kind;
      if (prior && prior.outcome !== "failed" && !sameRequest) {
        throw new DraftCreationOutcomeUnknownError(prior, deps.outcomeUnknownMessage());
      }
      const revision = sameRequest ? prior.revision : 0;
      const attempt: Attempt = { kind: input.kind, key, outcome: "pending", revision, error: null };
      const pending = { ...previous, attempt };
      try {
        await deps.storage.setItem(scope.key, JSON.stringify(pending));
      } catch (error) {
        // A rejected storage write may have committed. Undo it before allowing an edited retry.
        await restore(scope, previous);
        throw error;
      }
      scope.record = pending;

      function onEvent(snapshot: CreationSnapshot): void {
        const current = scope.record.attempt!;
        const matches = snapshot.kind === current.kind && snapshot.idempotencyKey === current.key;
        const replayedFailure =
          current.outcome === "pending" &&
          snapshot.phase === "failed" &&
          snapshot.outcomeUnknown === false &&
          snapshot.revision === current.revision;
        if (!matches || snapshot.revision < current.revision || replayedFailure) return;
        let outcome: Attempt["outcome"] = "pending";
        if (snapshot.phase === "completed") outcome = "completed";
        if (snapshot.phase === "failed") {
          outcome = snapshot.outcomeUnknown === false ? "failed" : "unknown";
        }
        checkpoint(scope, {
          ...scope.record,
          attempt: {
            kind: snapshot.kind,
            key: snapshot.idempotencyKey,
            outcome,
            revision: snapshot.revision,
            error: snapshot.error,
          },
        });
        input.onEvent?.(snapshot);
      }

      try {
        return await input.send({ idempotencyKey: key, onEvent });
      } catch (error) {
        if (deps.isNotSent(error)) await restore(scope, previous);
        throw error;
      } finally {
        await scope.writes;
      }
    });
  }

  return { submit, worktreeSlug };
}
