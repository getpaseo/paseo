import type pino from "pino";
import type { SubscribeCheckoutDiffRequest, SessionOutboundMessage } from "./messages.js";
import type { WorkspaceGitService } from "./workspace-git-service.js";
import type { WorkspaceRuntimeStore } from "./workspace-runtime-store/index.js";
import { DiffSubscriptions, type CommitFileRead } from "./diff/index.js";
import {
  DiffOpcode,
  materializeDiffFile,
  type DiffFrame,
  type DiffBegin,
  type DiffBody,
} from "@getpaseo/protocol/binary-frames/index";
import type { ParsedDiffFile } from "@getpaseo/protocol/messages";
import {
  CHECKOUT_DIFF_MAX_STRUCTURED_BYTES,
  resolveCheckoutDiffBase,
} from "../utils/checkout-git.js";
import { expandTilde } from "../utils/path.js";
import { toCheckoutError } from "./checkout-git-utils.js";

export type CheckoutDiffCompareInput = SubscribeCheckoutDiffRequest["compare"];
export type CheckoutDiffSnapshotPayload = Omit<
  Extract<SessionOutboundMessage, { type: "checkout_diff_update" }>["payload"],
  "subscriptionId"
>;
export interface CheckoutDiffMetrics {
  checkoutDiffTargetCount: number;
  checkoutDiffSubscriptionCount: number;
  checkoutDiffWatcherCount: number;
  checkoutDiffFallbackRefreshTargetCount: number;
}
export interface CheckoutDiffSubscriptionRequest {
  cwd: string;
  compare: CheckoutDiffCompareInput;
  signal?: AbortSignal;
}
export interface CheckoutDiffSubscription {
  initial: CheckoutDiffSnapshotPayload;
  unsubscribe(): void;
}

// COMPAT(diffSubscription): added in v0.15.0, remove after 2027-05-06.
// Old clients receive the same JSON snapshot while the shared engine owns reads and observation.
export class CheckoutDiffManager {
  readonly streams: DiffSubscriptions;
  private readonly paseoHome: string;
  constructor(options: {
    logger: pino.Logger;
    paseoHome: string;
    workspaceGitService: Pick<WorkspaceGitService, "requestWorkingTreeWatch">;
    workspaceRuntimeStore: WorkspaceRuntimeStore;
  }) {
    this.streams = new DiffSubscriptions(options.workspaceGitService);
    this.paseoHome = options.paseoHome;
  }
  readCommitFile(input: CommitFileRead) {
    return this.streams.readCommitFile(input);
  }
  async read(
    params: Omit<CheckoutDiffSubscriptionRequest, "signal">,
  ): Promise<CheckoutDiffSnapshotPayload> {
    const subscription = await this.subscribe(params, () => {});
    await subscription.unsubscribe();
    return subscription.initial;
  }
  async subscribe(
    params: CheckoutDiffSubscriptionRequest,
    listener: (snapshot: CheckoutDiffSnapshotPayload) => void,
  ): Promise<CheckoutDiffSubscription> {
    const cwd = expandTilde(params.cwd);
    let resolveInitial!: (snapshot: CheckoutDiffSnapshotPayload) => void;
    const initial = new Promise<CheckoutDiffSnapshotPayload>((resolve) => {
      resolveInitial = resolve;
    });
    let delivered = false;
    let pending: DiffBegin | null = null;
    let files = new Map<string, ParsedDiffFile>();
    let bodies = new Map<string, DiffBody>();
    const receive = async (frame: DiffFrame) => {
      if (params.signal?.aborted) return;
      if (frame.opcode === DiffOpcode.Begin) {
        pending = frame;
        bodies = new Map();
        return;
      }
      if (!pending || frame.revision !== pending.revision) return;
      if (frame.opcode === DiffOpcode.Bodies) {
        for (const body of frame.files) bodies.set(body.path, body);
        return;
      }
      let payload: CheckoutDiffSnapshotPayload;
      if (frame.error) {
        const message = frame.error.message;
        payload = {
          cwd,
          files: [],
          error: toCheckoutError(new Error(message)),
          diffTooLarge: frame.diffTooLarge,
        };
        files.clear();
      } else {
        const next = new Map<string, ParsedDiffFile>();
        const omitted = new Set(frame.omitted);
        for (const entry of pending.entries) {
          const previous = pending.baseRevision ? files.get(entry.path) : undefined;
          const body = bodies.get(entry.path) ?? null;
          const file = materializeDiffFile(entry, body, omitted.has(entry.path));
          if (!entry.body && previous && entry.content === "text" && !omitted.has(entry.path))
            file.hunks = previous.hunks;
          next.set(entry.path, file);
        }
        files = next;
        // Stream omissions remain file placeholders; the JSON budget rejects a legacy snapshot.
        payload = legacySnapshot(cwd, [...next.values()]);
      }
      pending = null;
      if (delivered) listener(payload);
      else {
        delivered = true;
        resolveInitial(payload);
      }
    };
    try {
      const baseRef = await resolveCheckoutDiffBase(cwd, params.compare, {
        paseoHome: this.paseoHome,
      });
      if (!baseRef) return { initial: { cwd, files: [], error: null }, unsubscribe() {} };
      const subscription = await this.streams.subscribe(
        {
          cwd,
          base: { kind: "rev", rev: baseRef },
          checkoutBase:
            params.compare.mode === "uncommitted"
              ? undefined
              : { compare: params.compare, paseoHome: this.paseoHome },
          head:
            params.compare.mode === "base" ? { kind: "rev", rev: "HEAD" } : { kind: "worktree" },
          mergeBase: params.compare.mode !== "uncommitted",
          ignoreWhitespace: params.compare.ignoreWhitespace,
        },
        receive,
      );
      const unsubscribe = async () => {
        if (!delivered) {
          delivered = true;
          resolveInitial({
            cwd,
            files: [],
            error: toCheckoutError(new Error("Diff subscription cancelled")),
          });
        }
        params.signal?.removeEventListener("abort", unsubscribe);
        await subscription.release();
      };
      params.signal?.addEventListener("abort", unsubscribe, { once: true });
      if (params.signal?.aborted) {
        await subscription.release();
        throw new Error("Diff subscription cancelled");
      }
      await subscription.start();
      return { initial: await initial, unsubscribe };
    } catch (error) {
      return { initial: { cwd, files: [], error: toCheckoutError(error) }, unsubscribe() {} };
    }
  }
  scheduleRefreshForCwd(cwd: string): Promise<void> {
    return this.streams.invalidateForCwd(expandTilde(cwd));
  }
  getMetrics(): CheckoutDiffMetrics {
    const metrics = this.streams.getMetrics();
    return {
      checkoutDiffTargetCount: metrics.targets,
      checkoutDiffSubscriptionCount: metrics.subscriptions,
      checkoutDiffWatcherCount: metrics.metadataObservers,
      checkoutDiffFallbackRefreshTargetCount: 0,
    };
  }
  async dispose(): Promise<void> {
    await this.streams.close();
  }
}

function legacySnapshot(cwd: string, files: ParsedDiffFile[]): CheckoutDiffSnapshotPayload {
  let bytes = 2;
  for (let index = 0; index < files.length; index++) {
    bytes += Buffer.byteLength(JSON.stringify(files[index])) + Number(index > 0);
    if (bytes > CHECKOUT_DIFF_MAX_STRUCTURED_BYTES) {
      return legacyTooLarge(cwd);
    }
  }
  return { cwd, files, error: null };
}

function legacyTooLarge(cwd: string): CheckoutDiffSnapshotPayload {
  return {
    cwd,
    files: [],
    diffTooLarge: true,
    error: toCheckoutError(new Error("Diff too large to display")),
  };
}
