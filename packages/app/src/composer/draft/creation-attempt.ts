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

interface CreationOptions {
  idempotencyKey: string;
  onEvent: (snapshot: CreationSnapshot) => void;
}

interface Submission<Result> {
  serverId: string;
  draftId: string;
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

/** Persist admission before sending: a timeout or app restart cannot authorize a second creation. */
export function createDraftCreations(storage: Storage, outcomeUnknownMessage: () => string) {
  const attempts = new Map<string, Attempt>();
  let admission: Promise<void> = Promise.resolve();
  let writes: Promise<void> = Promise.resolve();

  function save(scope: string, attempt: Attempt): void {
    attempts.set(scope, attempt);
    const serialized = JSON.stringify(attempt);
    writes = writes.catch(() => undefined).then(() => storage.setItem(scope, serialized));
    // The submitting call awaits writes; observing progress must not create an unhandled rejection.
    void writes.catch(() => undefined);
  }

  async function submit<Result>(input: Submission<Result>): Promise<Result> {
    const scope = `draft-creation:${JSON.stringify([input.serverId, input.draftId])}`;
    const key = draftCreationKey(input.draftId, input.request);
    const admitted = admission.then(async () => {
      // Earlier callers see their write failure. A later admission can retry storage.
      await writes.catch(() => undefined);
      const stored = await storage.getItem(scope);
      const persisted = stored === null ? null : AttemptSchema.parse(JSON.parse(stored));
      const previous = attempts.get(scope) ?? persisted;
      const sameRequest = previous?.key === key && previous.kind === input.kind;
      if (previous && previous.outcome !== "failed" && !sameRequest) {
        throw new DraftCreationOutcomeUnknownError(previous, outcomeUnknownMessage());
      }
      const revision = sameRequest ? previous.revision : 0;
      save(scope, { kind: input.kind, key, outcome: "pending", revision, error: null });
      return writes;
    });
    admission = admitted.then(
      () => undefined,
      () => undefined,
    );
    await admitted;

    function onEvent(snapshot: CreationSnapshot): void {
      const current = attempts.get(scope)!;
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
      save(scope, {
        kind: snapshot.kind,
        key: snapshot.idempotencyKey,
        outcome,
        revision: snapshot.revision,
        error: snapshot.error,
      });
      input.onEvent?.(snapshot);
    }

    try {
      return await input.send({ idempotencyKey: key, onEvent });
    } finally {
      await writes;
    }
  }

  return { submit };
}
