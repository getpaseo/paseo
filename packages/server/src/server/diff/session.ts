import type { Logger } from "pino";
import { encodeDiffFrame } from "@getpaseo/protocol/binary-frames/index";
import type {
  DiffSubscribeRequest,
  SessionOutboundMessage,
  DiffError,
} from "@getpaseo/protocol/messages";
import type { SessionDelivery, OwnedSubscription } from "../session/owned-subscriptions/index.js";
import { DiffReadError } from "./git.js";
import type { DiffSubscriptions, DiffSubscription } from "./index.js";

export class DiffSession {
  private slots = new Set<number>();
  constructor(
    private subscriptions: DiffSubscriptions,
    private logger: Pick<Logger, "debug" | "error">,
  ) {}
  async subscribe(
    msg: DiffSubscribeRequest,
    ownership: SessionDelivery,
    emit: (message: SessionOutboundMessage) => void,
  ): Promise<void> {
    const slot = Array.from({ length: 256 }, (_, value) => value).find(
      (value) => !this.slots.has(value),
    );
    if (slot === undefined) {
      this.reject(msg, emit, {
        code: "TOO_MANY_SUBSCRIPTIONS",
        message: "Too many diff subscriptions",
      });
      return;
    }
    this.slots.add(slot);
    let subscription: DiffSubscription | null = null;
    const owner = ownership.begin("diffs", undefined, async () => {
      this.slots.delete(slot);
      await subscription?.release();
    });
    try {
      subscription = await this.subscriptions.subscribe(msg, async (frame) => {
        if (owner.signal.aborted) return;
        const bytes = encodeDiffFrame({ ...frame, slot });
        try {
          await owner.emitBinaryAndWait(bytes);
        } catch (error) {
          void this.stopFailedSource(owner, error);
        }
      });
      if (owner.signal.aborted) {
        await subscription.release();
        return;
      }
      emit({
        type: "diff.subscribe.response",
        payload: { requestId: msg.requestId, subscriptionId: owner.responseId, slot, error: null },
      });
      // Start outside the request context: the owned subscription carries delivery authority.
      void subscription.start().catch((error) => this.stopFailedSource(owner, error));
    } catch (error) {
      await owner.release();
      const code = error instanceof DiffReadError ? error.code : "UNKNOWN";
      this.reject(msg, emit, {
        code,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  private async stopFailedSource(owner: OwnedSubscription, error: unknown): Promise<void> {
    if (!owner.signal.aborted) this.logger.debug({ err: error }, "Diff frame delivery failed");
    try {
      await owner.release();
    } catch (failure) {
      this.logger.error({ err: failure }, "Failed to release diff subscription");
    }
  }
  private reject(
    msg: DiffSubscribeRequest,
    emit: (message: SessionOutboundMessage) => void,
    error: DiffError,
  ): void {
    emit({
      type: "diff.subscribe.response",
      payload: { requestId: msg.requestId, subscriptionId: "", slot: 0, error },
    });
  }
}
