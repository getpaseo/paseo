import type { Logger } from "pino";
import type {
  KeeperEvent,
  KeeperGetPendingRequestRequest,
  KeeperGetPendingRequestResponse,
  KeeperGetSnapshotResponse,
  KeeperReadEventsResponse,
  KeeperSendMessageRequest,
  KeeperSendMessageResponse,
  KeeperStateSummary,
} from "@getpaseo/protocol/messages";
import {
  AdmissionRefused,
  type AgentControlState,
  type AgentManager,
  type AgentManagerEvent,
} from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { PermissionChange } from "../agent/tracked-permission-map.js";
import { withTimeout } from "../../utils/promise-timeout.js";
import type { KeeperEventInput, KeeperEventOutbox } from "./event-outbox.js";
import {
  type KeeperSendReceipts,
  type ReceiptOutcome,
  sendFingerprint,
  sendKey,
} from "./send-receipts.js";

const DETAIL_INPUT_LIMIT = 8_000;
const DETAIL_TEXT_LIMIT = 2_000;
const DEFAULT_EVENT_LIMIT = 100;
const START_TIMEOUT_MS = 60_000;

type SendPayload = KeeperSendMessageResponse["payload"];

export interface KeeperControlDeps {
  enabled: boolean;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  receipts: KeeperSendReceipts;
  outbox: KeeperEventOutbox;
  logger: Logger;
}

export class KeeperControl {
  private readonly seen = new Map<string, { incarnation: string | null; lifecycle: string }>();

  private stop: () => void = () => {};

  constructor(private readonly deps: KeeperControlDeps) {}

  /** Feeds the outbox from the manager; returns the unsubscribe. */
  start(): () => void {
    const manager = this.deps.agentManager;
    const offPermissions = manager.subscribePermissionChanges((change) =>
      this.onPermission(change),
    );
    const offEvents = manager.subscribe((event) => this.onManagerEvent(event), {
      replayState: false,
    });
    this.stop = () => {
      offPermissions();
      offEvents();
    };
    return this.stop;
  }

  /** Marks agents whose close outlived the shutdown timeout; their closure event may be missing. */
  noteUnclosed(agentIds: string[]): void {
    for (const agentId of agentIds) {
      this.emit({ category: "lifecycle", type: "lifecycle.close_timeout", agentId });
    }
  }

  async close(): Promise<void> {
    this.stop();
    await this.deps.outbox.flush();
    this.deps.outbox.close();
  }

  /** Set once the outbox latched a write error; the feed then stops advancing. */
  feedError(): string | null {
    const error = this.deps.outbox.lastWriteError();
    return error ? `event feed stalled: ${error.message}` : null;
  }

  get enabled(): boolean {
    return this.deps.enabled;
  }

  snapshot(agentId: string): KeeperGetSnapshotResponse["payload"]["snapshot"] {
    const state = this.deps.agentManager.getControlState(agentId);
    if (!state) return null;
    return {
      ...summarize(state),
      pending: state.pending.map((p) => ({ permissionRequestId: p.id, kind: p.kind })),
      eventCursor: this.deps.outbox.headCursor(),
    };
  }

  get bootId(): string {
    return this.deps.agentManager.bootId;
  }

  pendingDetail(req: KeeperGetPendingRequestRequest): KeeperGetPendingRequestResponse["payload"] {
    const base = { requestId: req.requestId, agentId: req.agentId, detail: null, error: null };
    const state = this.deps.agentManager.getControlState(req.agentId);
    if (!state) return { ...base, reason: "not_found" };
    if (state.sessionIncarnation !== req.expectedSessionIncarnation) {
      return { ...base, reason: "stale_incarnation" };
    }
    if (state.permissionGeneration !== req.expectedPermissionGeneration) {
      return { ...base, reason: "stale_generation" };
    }
    const found = state.pending.find((p) => p.id === req.permissionRequestId);
    if (!found) return { ...base, reason: "not_found" };
    const input = found.input === undefined ? null : JSON.stringify(found.input);
    const cut = (text: string | undefined, limit: number) => text?.slice(0, limit) ?? null;
    return {
      ...base,
      reason: null,
      detail: {
        permissionRequestId: found.id,
        kind: found.kind,
        name: found.name,
        title: cut(found.title, DETAIL_TEXT_LIMIT),
        description: cut(found.description, DETAIL_TEXT_LIMIT),
        input: cut(input ?? undefined, DETAIL_INPUT_LIMIT),
        truncated:
          (input?.length ?? 0) > DETAIL_INPUT_LIMIT ||
          (found.title?.length ?? 0) > DETAIL_TEXT_LIMIT ||
          (found.description?.length ?? 0) > DETAIL_TEXT_LIMIT,
      },
    };
  }

  async readEvents(
    cursor: string | null,
    limit: number | undefined,
    waitMs: number | undefined,
  ): Promise<Omit<KeeperReadEventsResponse["payload"], "requestId" | "error">> {
    return this.deps.outbox.read(cursor, limit ?? DEFAULT_EVENT_LIMIT, waitMs ?? 0);
  }

  async send(req: KeeperSendMessageRequest): Promise<SendPayload> {
    const reply = (result: string, reason: string | null, extra: Partial<SendPayload> = {}) => ({
      requestId: req.requestId,
      agentId: req.agentId,
      idempotencyKey: req.idempotencyKey,
      result,
      reason,
      delivery: null,
      current: null,
      error: null,
      ...extra,
    });
    const compared: { state: AgentControlState | null } = { state: null };
    const reject = (reason: string, state: AgentControlState | null = null) => {
      compared.state = state;
      return reply("rejected", reason, { current: state ? summarize(state) : null });
    };
    if (!this.deps.enabled) return reject("disabled");
    const { receipts } = this.deps;
    const fingerprint = sendFingerprint(req.text, req.onActiveTurn);
    const outcome = await receipts.serialize(req.agentId, req.idempotencyKey, async () => {
      const prior = await receipts.lookup(req.agentId, req.idempotencyKey, fingerprint);
      if (prior.kind === "duplicate") return reply("duplicate", null, { delivery: prior.delivery });
      if (prior.kind === "outcome_unknown") return reply("outcome_unknown", null);
      if (prior.kind === "idempotency_conflict") return reject("idempotency_conflict");
      const record = await this.deps.agentStorage.get(req.agentId);
      if (record?.archivedAt) return reject("agent_archived");
      return this.admitAndSend(req, fingerprint, reply, reject);
    });
    if (outcome.result === "rejected" && outcome.reason !== "disabled") {
      try {
        await this.recordRejected(req, outcome.reason, compared.state);
      } catch (error) {
        return reply("outcome_unknown", null, { error: messageOf(error) });
      }
    }
    return outcome;
  }

  /** Daemon-side proof that a rejected send was attempted; durable before the reply goes out. */
  private async recordRejected(
    req: KeeperSendMessageRequest,
    reason: string | null,
    state: AgentControlState | null,
  ): Promise<void> {
    const { outbox, logger } = this.deps;
    outbox.append({
      category: "send",
      type: "send.rejected",
      agentId: req.agentId,
      bootId: this.bootId,
      sessionIncarnation: state?.sessionIncarnation ?? null,
      permissionGeneration: state?.permissionGeneration ?? null,
      permissionRequestId: null,
      turnId: null,
      lifecycle: null,
      reason,
      sendKey: sendKey(req.agentId, req.idempotencyKey),
    });
    try {
      await outbox.flush();
      const writeError = outbox.lastWriteError();
      if (writeError) throw writeError;
    } catch (error) {
      logger.error({ err: error, agentId: req.agentId }, "Keeper reject event flush failed");
      throw error;
    }
  }

  private async admitAndSend(
    req: KeeperSendMessageRequest,
    fingerprint: string,
    reply: (result: string, reason: string | null, extra?: Partial<SendPayload>) => SendPayload,
    reject: (reason: string, state?: AgentControlState | null) => SendPayload,
  ): Promise<SendPayload> {
    const { agentManager, receipts } = this.deps;
    let admitted;
    const matched: { state: AgentControlState | null } = { state: null };
    const held: { outcome: ReceiptOutcome | null } = { outcome: null };
    try {
      admitted = await agentManager.admitGuarded(
        req.agentId,
        {
          expectedSessionIncarnation: req.expectedSessionIncarnation,
          expectedPermissionGeneration: req.expectedPermissionGeneration,
          allowPendingPermissions: req.allowPendingPermissions,
          // Identity recorded in the receipt is what the lane compared and matched, not the request.
          reserve: async (seen) => {
            const outcome = await receipts.reserve(req.agentId, req.idempotencyKey, fingerprint, {
              bootId: this.bootId,
              sessionIncarnation: seen.sessionIncarnation,
              permissionGeneration: seen.permissionGeneration,
            });
            if (outcome.kind !== "none") {
              held.outcome = outcome;
              return { ok: false, reason: `receipt_${outcome.kind}` };
            }
            const latest = await this.deps.agentStorage.get(req.agentId);
            if (!latest?.archivedAt) return { ok: true };
            await this.releaseReceipt(req);
            return { ok: false, reason: "agent_archived" };
          },
          release: () => this.releaseReceipt(req),
        },
        async (context) => {
          matched.state = context.state;
          const options = { clientMessageId: `keeper:${req.idempotencyKey}` };
          if (context.state.hasActiveTurn) {
            if (req.onActiveTurn === "reject") throw new AdmissionRefused("turn_active");
            await agentManager.steerHeld(context, req.text, options);
            return "steered";
          }
          const iterator = agentManager.startTurnHeld(context, req.text, options);
          // The first event means the provider accepted the turn, even if it then ends at once.
          // One continuation drains the rest, also when the result arrives after the timeout.
          const firstEvent = iterator.next();
          void firstEvent.then(
            (first) => drain(iterator, this.deps.logger, req.agentId, first.done === true),
            () => undefined,
          );
          await withTimeout({
            promise: firstEvent,
            timeoutMs: START_TIMEOUT_MS,
            label: "keeper turn start",
          });
          return "turn_started";
        },
      );
    } catch (error) {
      return reply("outcome_unknown", null, { error: messageOf(error) });
    }
    if ("rejected" in admitted) {
      const prior = held.outcome;
      if (prior?.kind === "duplicate")
        return reply("duplicate", null, { delivery: prior.delivery });
      if (prior?.kind === "outcome_unknown") return reply("outcome_unknown", null);
      if (prior?.kind === "idempotency_conflict") return reject("idempotency_conflict");
      return reject(admitted.rejected, admitted.state);
    }
    try {
      const matchedState = matched.state;
      if (!matchedState) throw new Error("admitted without a matched state");
      await receipts.complete(req.agentId, req.idempotencyKey, fingerprint, admitted.value, {
        bootId: this.bootId,
        sessionIncarnation: matchedState.sessionIncarnation,
        permissionGeneration: matchedState.permissionGeneration,
      });
    } catch (error) {
      // The provider may have the message; the pending receipt makes every retry report that.
      return reply("outcome_unknown", null, { error: messageOf(error) });
    }
    const current = agentManager.getControlState(req.agentId);
    return reply("accepted", null, {
      delivery: admitted.value,
      current: current ? summarize(current) : null,
    });
  }

  /** A rejection means nothing was sent, so the receipt must go; one retry, then the error surfaces. */
  private async releaseReceipt(req: KeeperSendMessageRequest): Promise<void> {
    const { receipts, logger } = this.deps;
    let last: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await receipts.release(req.agentId, req.idempotencyKey);
        return;
      } catch (error) {
        last = error;
        logger.error({ err: error, agentId: req.agentId }, "Keeper receipt release failed");
      }
    }
    throw last;
  }

  private emit(
    input: Partial<KeeperEventInput> & Pick<KeeperEventInput, "category" | "type" | "agentId">,
  ) {
    const state = this.deps.agentManager.getControlState(input.agentId);
    const event: KeeperEventInput = {
      bootId: this.bootId,
      sessionIncarnation: state?.sessionIncarnation ?? null,
      permissionGeneration: state?.permissionGeneration ?? null,
      permissionRequestId: null,
      turnId: null,
      lifecycle: state?.lifecycle ?? null,
      ...input,
    };
    this.deps.outbox.append(event);
  }

  private onPermission(change: PermissionChange): void {
    const category = change.kind === "question" ? "question" : "permission";
    this.deps.outbox.append({
      category,
      type: `${category}.${change.change}`,
      agentId: change.agentId,
      bootId: this.bootId,
      sessionIncarnation: change.sessionIncarnation,
      permissionGeneration: change.generation,
      permissionRequestId: change.requestId,
      turnId: null,
      lifecycle: null,
    });
  }

  private onManagerEvent(event: AgentManagerEvent): void {
    if (event.type === "agent_state") {
      const id = event.agent.id;
      const incarnation = event.agent.sessionIncarnation ?? null;
      const lifecycle = event.agent.lifecycle;
      const before = this.seen.get(id);
      this.seen.set(id, { incarnation, lifecycle });
      if (before && before.incarnation !== incarnation) {
        this.emit({ category: "lifecycle", type: "lifecycle.session_replaced", agentId: id });
      } else if (!before || before.lifecycle !== lifecycle) {
        this.emit({ category: "lifecycle", type: "lifecycle.changed", agentId: id, lifecycle });
      }
      return;
    }
    if (event.type !== "agent_stream") return;
    const kind = event.event.type;
    if (kind !== "turn_completed" && kind !== "turn_failed" && kind !== "turn_canceled") return;
    this.emit({
      category: "turn_complete",
      type: `turn.${kind.slice("turn_".length)}`,
      agentId: event.agentId,
      turnId: event.event.turnId ?? null,
    });
  }
}

function summarize(state: AgentControlState): KeeperStateSummary {
  return {
    sessionIncarnation: state.sessionIncarnation,
    permissionGeneration: state.permissionGeneration,
    pendingPermissionCount: state.pending.length,
    lifecycle: state.lifecycle,
    hasActiveTurn: state.hasActiveTurn,
  };
}

async function drain(
  iterator: AsyncGenerator<unknown>,
  logger: Logger,
  agentId: string,
  finished: boolean,
): Promise<void> {
  if (finished) return;
  try {
    for await (const _ of iterator) {
      // Events reach consumers through manager subscribers.
    }
  } catch (error) {
    logger.error({ err: error, agentId }, "Keeper send stream failed");
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type { KeeperEvent };
