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
import type { KeeperEventInput, KeeperEventOutbox } from "./event-outbox.js";
import { type KeeperSendReceipts, sendFingerprint } from "./send-receipts.js";

const DETAIL_INPUT_LIMIT = 8_000;
const DETAIL_TEXT_LIMIT = 2_000;
const DEFAULT_EVENT_LIMIT = 100;

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
    return () => {
      offPermissions();
      offEvents();
    };
  }

  async close(): Promise<void> {
    await this.deps.outbox.flush();
    this.deps.outbox.close();
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
    const reject = (reason: string, state: AgentControlState | null = null) =>
      reply("rejected", reason, { current: state ? summarize(state) : null });
    if (!this.deps.enabled) return reject("disabled");
    const { agentManager, receipts } = this.deps;
    if (!agentManager.getAgent(req.agentId)) return reject("agent_not_found");
    const record = await this.deps.agentStorage.get(req.agentId);
    if (record?.archivedAt) return reject("agent_archived");

    const fingerprint = sendFingerprint(req.text, req.onActiveTurn);
    return receipts.serialize(req.agentId, req.idempotencyKey, async () => {
      const prior = await receipts.lookup(req.agentId, req.idempotencyKey, fingerprint);
      if (prior.kind === "duplicate") return reply("duplicate", null, { delivery: prior.delivery });
      if (prior.kind === "outcome_unknown") return reply("outcome_unknown", null);
      if (prior.kind === "idempotency_conflict") return reject("idempotency_conflict");
      return this.admitAndSend(req, fingerprint, reply, reject);
    });
  }

  private async admitAndSend(
    req: KeeperSendMessageRequest,
    fingerprint: string,
    reply: (result: string, reason: string | null, extra?: Partial<SendPayload>) => SendPayload,
    reject: (reason: string, state?: AgentControlState | null) => SendPayload,
  ): Promise<SendPayload> {
    const { agentManager, receipts } = this.deps;
    let admitted;
    try {
      admitted = await agentManager.admitGuarded(
        req.agentId,
        {
          expectedSessionIncarnation: req.expectedSessionIncarnation,
          expectedPermissionGeneration: req.expectedPermissionGeneration,
          allowPendingPermissions: req.allowPendingPermissions,
          reserve: async () => {
            await receipts.reserve(req.agentId, req.idempotencyKey, fingerprint);
            const latest = await this.deps.agentStorage.get(req.agentId);
            if (!latest?.archivedAt) return { ok: true };
            await receipts.release(req.agentId, req.idempotencyKey);
            return { ok: false, reason: "agent_archived" };
          },
          release: () => receipts.release(req.agentId, req.idempotencyKey),
        },
        async (context) => {
          const options = { clientMessageId: `keeper:${req.idempotencyKey}` };
          if (context.state.hasActiveTurn) {
            if (req.onActiveTurn === "reject") throw new AdmissionRefused("turn_active");
            await agentManager.steerHeld(context, req.text, options);
            return "steered";
          }
          const iterator = agentManager.startTurnHeld(context, req.text, options);
          void drain(iterator, this.deps.logger, req.agentId);
          return "turn_started";
        },
      );
    } catch (error) {
      return reply("outcome_unknown", null, { error: messageOf(error) });
    }
    if ("rejected" in admitted) return reject(admitted.rejected, admitted.state);
    try {
      if (admitted.value === "turn_started") {
        await waitStart(agentManager, req.agentId);
      }
      await receipts.complete(req.agentId, req.idempotencyKey, fingerprint, admitted.value);
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
): Promise<void> {
  try {
    for await (const _ of iterator) {
      // Events reach consumers through manager subscribers.
    }
  } catch (error) {
    logger.error({ err: error, agentId }, "Keeper send stream failed");
  }
}

async function waitStart(agentManager: AgentManager, agentId: string): Promise<void> {
  const { waitForAgentRunStartWithTimeout } = await import("../agent/agent-prompt.js");
  await waitForAgentRunStartWithTimeout(agentManager, agentId);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type { KeeperEvent };
