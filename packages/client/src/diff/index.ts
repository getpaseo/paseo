import {
  decodeDiffFrame,
  type DiffEntry as WireEntry,
  type DiffBegin,
} from "@getpaseo/protocol/binary-frames/index";
import type {
  DiffSubscribeRequest,
  SubscribeCheckoutDiffRequest,
  DiffError,
  DiffSubscribeResponse,
  SubscribeCheckoutDiffResponse,
  ParsedDiffFile,
} from "@getpaseo/protocol/messages";
import type { OwnedSubscription, SubscriptionObserver } from "../connection/index.js";
import { DiffStream } from "./stream.js";
export type { DiffEndpoint } from "@getpaseo/protocol/messages";
export type DiffCompare = Omit<DiffSubscribeRequest, "type" | "requestId">;

export type DiffEntry = Omit<WireEntry, "body">;
export type ResolvedShas = Pick<DiffBegin, "baseSha" | "headSha" | "mergeBaseSha">;

export type DiffState =
  | { phase: "loading"; revision: number; entries: DiffEntry[] }
  | {
      phase: "ready";
      revision: number;
      resolved: ResolvedShas;
      diffTooLarge: boolean;
      files: ParsedDiffFile[];
    }
  | { phase: "error"; revision: number; error: DiffError };
type LegacyCompare = SubscribeCheckoutDiffRequest["compare"];

interface Port {
  modern(compare: DiffCompare): OwnedSubscription<DiffSubscribeResponse["payload"]>;
  legacy(
    cwd: string,
    compare: LegacyCompare,
  ): OwnedSubscription<SubscribeCheckoutDiffResponse["payload"]>;
  failed(error: unknown): void;
}
export class DiffSubscriptionError extends Error {
  constructor(readonly detail: DiffError) {
    super(detail.message);
  }
}
interface Registration {
  start(modern: boolean): void;
  disconnected(): void;
  release(): Promise<void>;
}
/** Capability selection, slot ownership and reconnect belong to this domain. */
export class DiffStreamRouter {
  private registrations = new Set<Registration>();
  private slots = new Map<number, { receive(bytes: Uint8Array): void }>();
  private mode: boolean | null = null;
  constructor(private port: Port) {}
  connected(modern: boolean): void {
    this.mode = modern;
    for (const registration of this.registrations) registration.start(modern);
  }
  disconnected(): void {
    this.mode = null;
    this.slots.clear();
    for (const registration of this.registrations) registration.disconnected();
  }
  async close(): Promise<void> {
    await Promise.all([...this.registrations].map((registration) => registration.release()));
  }
  receive(bytes: Uint8Array): void {
    const owner = this.slots.get(bytes[1]);
    owner?.receive(bytes);
  }
  private releaseBackend(backend: OwnedSubscription<unknown> | null): void {
    void backend?.release().catch(this.port.failed);
  }
  observe(compare: DiffCompare): OwnedSubscription<DiffState> {
    let backend: OwnedSubscription<unknown> | null = null;
    let state: (DiffState & { subscriptionId: string }) | null = null;
    let slot: number | null = null;
    let released = false;
    let generation = 0;
    let stream: DiffStream;
    const observers = new Set<SubscriptionObserver<DiffState & { subscriptionId: string }>>();
    let resolve!: (state: DiffState & { subscriptionId: string }) => void;
    const ready = new Promise<DiffState & { subscriptionId: string }>((accept) => {
      resolve = accept;
    });
    const publish = (value: DiffState) => {
      if (released) return;
      state = { ...value, subscriptionId: backend?.subscriptionId ?? "" };
      resolve(state);
      for (const observer of observers) {
        try {
          observer.snapshot(state);
        } catch (error) {
          this.port.failed(error);
        }
      }
    };
    const detach = () => {
      if (slot !== null) this.slots.delete(slot);
      slot = null;
    };
    const fail = (error: unknown) => {
      detach();
      publish({
        phase: "error",
        revision: 0,
        error:
          error instanceof DiffSubscriptionError
            ? error.detail
            : { code: "UNKNOWN", message: error instanceof Error ? error.message : String(error) },
      });
      this.releaseBackend(backend);
    };
    const registration: Registration = {
      start: (modern) => {
        if (released || backend) return;
        const current = ++generation;
        const failed = (error: unknown) => {
          if (current === generation) fail(error);
        };
        stream = new DiffStream(publish);
        if (modern) {
          const observation = this.port.modern(compare);
          backend = observation;
          observation.subscribe({
            snapshot: (payload) => {
              if (current !== generation) return;
              detach();
              if (payload.error) {
                fail(new DiffSubscriptionError(payload.error));
                return;
              }
              slot = payload.slot;
              const owner = {
                receive: (bytes: Uint8Array) => {
                  try {
                    stream.receive(decodeDiffFrame(bytes));
                  } catch (error) {
                    fail(error);
                  }
                },
              };
              this.slots.set(slot, owner);
            },
            update: () => {},
            error: failed,
          });
          void observation.ready.catch(failed);
        } else {
          // COMPAT(diffSubscription): added in v0.15.0, remove after 2027-05-06.
          const legacy = legacyCompare(compare);
          if (!legacy) {
            fail(
              new DiffSubscriptionError({
                code: "INVALID_COMPARE",
                message: "Update the host to use this comparison",
              }),
            );
            return;
          }
          const observation = this.port.legacy(compare.cwd, legacy);
          backend = observation;
          const apply = (
            payload: Pick<
              SubscribeCheckoutDiffResponse["payload"],
              "files" | "error" | "diffTooLarge"
            >,
          ) => {
            if (current !== generation) return;
            if (payload.error)
              publish({
                phase: "error",
                revision: 0,
                error: {
                  code: payload.error.code === "NOT_GIT_REPO" ? "NOT_GIT_REPO" : "UNKNOWN",
                  message: payload.error.message,
                },
              });
            else
              publish({
                phase: "ready",
                revision: (state?.revision ?? 0) + 1,
                resolved: { baseSha: "", headSha: "", mergeBaseSha: "" },
                diffTooLarge: payload.diffTooLarge === true,
                files: payload.files,
              });
          };
          observation.subscribe({
            snapshot: apply,
            update: (message) => {
              if (message.type === "checkout_diff_update") apply(message.payload);
            },
            error: failed,
          });
          void observation.ready.catch(failed);
        }
      },
      disconnected: () => {
        generation++;
        detach();
        state = null;
        const old = backend;
        backend = null;
        void old?.release().catch(this.port.failed);
      },
      release: async () => {
        if (released) return;
        released = true;
        generation++;
        detach();
        this.registrations.delete(registration);
        await backend?.release();
        observers.clear();
      },
    };
    this.registrations.add(registration);
    if (this.mode !== null) registration.start(this.mode);
    return {
      get subscriptionId() {
        return backend?.subscriptionId ?? null;
      },
      ready,
      subscribe: (observer) => {
        observers.add(observer);
        if (state) observer.snapshot(state);
        return () => observers.delete(observer);
      },
      release: () => registration.release(),
    };
  }
}
function legacyCompare(compare: DiffCompare): LegacyCompare | null {
  if (compare.highlight === false) return null;
  const { base, head } = compare;
  if (base.kind !== "rev") return null;
  if (base.rev === "HEAD" && head.kind === "worktree")
    return { mode: "uncommitted", ignoreWhitespace: compare.ignoreWhitespace };
  if (compare.mergeBase && head.kind === "rev" && head.rev === "HEAD")
    return { mode: "base", baseRef: base.rev, ignoreWhitespace: compare.ignoreWhitespace };
  if (compare.mergeBase && head.kind === "worktree")
    return { mode: "all", baseRef: base.rev, ignoreWhitespace: compare.ignoreWhitespace };
  return null;
}
