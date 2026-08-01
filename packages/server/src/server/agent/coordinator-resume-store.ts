import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

import { writeJsonFileAtomic } from "../atomic-file.js";

const CoordinatorResumeStateSchema = z.enum([
  "armed",
  "pending",
  "leased",
  "delivered",
  "acked",
  "child_canceled",
  "child_missing",
  "child_archived",
  "ownership_changed",
  "coordinator_missing",
  "coordinator_archived",
  "coordinator_unsupported",
]);

const CoordinatorResumeEventSchema = z
  .object({
    eventId: z.string().min(1),
    childAgentId: z.string().min(1),
    coordinatorAgentId: z.string().min(1),
    childTurnId: z.string().min(1).nullable(),
    childOutcome: z.enum(["completed", "failed"]).nullable(),
    childOutcomeId: z.string().min(1).nullable(),
    resultLocator: z.string().min(1).nullable(),
    state: CoordinatorResumeStateSchema,
    attempt: z.number().int().nonnegative(),
    nextAttemptAt: z.string().datetime().nullable(),
    leaseId: z.string().min(1).nullable(),
    leaseExpiresAt: z.string().datetime().nullable(),
    coordinatorTurnId: z.string().min(1).nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    deliveredAt: z.string().datetime().nullable(),
    ackedAt: z.string().datetime().nullable(),
  })
  .strict();

const CoordinatorResumeFileSchema = z
  .object({
    events: z.array(CoordinatorResumeEventSchema),
  })
  .strict();

export type CoordinatorResumeState = z.infer<typeof CoordinatorResumeStateSchema>;
export type CoordinatorResumeEvent = z.infer<typeof CoordinatorResumeEventSchema>;
export type ChildTerminalOutcome = NonNullable<CoordinatorResumeEvent["childOutcome"]>;

export interface CoordinatorResumeStoreOptions {
  now?: () => Date;
  idFactory?: () => string;
  baseRetryMs?: number;
  maxRetryMs?: number;
}

export interface LeaseCoordinatorResumeOptions {
  leaseMs: number;
}

type EventUpdater = (
  events: CoordinatorResumeEvent[],
) => CoordinatorResumeEvent[] | Promise<CoordinatorResumeEvent[]>;

function childOutcomeId(params: {
  childAgentId: string;
  childTurnId: string | null;
  eventId: string;
  outcome: ChildTerminalOutcome;
}): string {
  return [params.childAgentId, params.childTurnId ?? params.eventId, params.outcome].join(":");
}

function resultLocator(params: {
  childAgentId: string;
  childTurnId: string | null;
  eventId: string;
}): string {
  return ["agent-timeline", params.childAgentId, params.childTurnId ?? params.eventId].join(":");
}

export class CoordinatorResumeStore {
  private mutationTail: Promise<unknown> = Promise.resolve();
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly baseRetryMs: number;
  private readonly maxRetryMs: number;

  constructor(
    private readonly filePath: string,
    options: CoordinatorResumeStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.baseRetryMs = options.baseRetryMs ?? 1_000;
    this.maxRetryMs = options.maxRetryMs ?? 60_000;
  }

  async list(): Promise<CoordinatorResumeEvent[]> {
    return (await this.read()).events;
  }

  async arm(params: {
    childAgentId: string;
    coordinatorAgentId: string;
  }): Promise<CoordinatorResumeEvent> {
    const eventId = this.idFactory();
    const timestamp = this.now().toISOString();
    const event = CoordinatorResumeEventSchema.parse({
      eventId,
      childAgentId: params.childAgentId,
      coordinatorAgentId: params.coordinatorAgentId,
      childTurnId: null,
      childOutcome: null,
      childOutcomeId: null,
      resultLocator: null,
      state: "armed",
      attempt: 0,
      nextAttemptAt: null,
      leaseId: null,
      leaseExpiresAt: null,
      coordinatorTurnId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      deliveredAt: null,
      ackedAt: null,
    });

    await this.mutate((events) => [...events, event]);
    return event;
  }

  async bindChildTurn(eventId: string, childTurnId: string): Promise<CoordinatorResumeEvent> {
    let result: CoordinatorResumeEvent | null = null;
    await this.mutate((events) => {
      const existingOutcome = events.find(
        (event) =>
          event.eventId !== eventId &&
          event.childTurnId === childTurnId &&
          event.state !== "child_canceled" &&
          event.state !== "ownership_changed",
      );
      if (existingOutcome) {
        throw new Error(`Child turn ${childTurnId} is already bound to ${existingOutcome.eventId}`);
      }
      return events.map((event) => {
        if (event.eventId !== eventId) return event;
        if (event.state !== "armed") {
          if (event.childTurnId === childTurnId) {
            result = event;
            return event;
          }
          throw new Error(`Cannot bind child turn while event ${eventId} is ${event.state}`);
        }
        if (event.childTurnId && event.childTurnId !== childTurnId) {
          throw new Error(`Event ${eventId} is already bound to child turn ${event.childTurnId}`);
        }
        const updated = {
          ...event,
          childTurnId,
          updatedAt: this.now().toISOString(),
        };
        result = updated;
        return updated;
      });
    });
    if (!result) throw new Error(`Coordinator resume event not found: ${eventId}`);
    return result;
  }

  async promoteChild(params: {
    childAgentId: string;
    childTurnId: string;
    outcome: ChildTerminalOutcome;
    currentParentAgentId: string | null;
  }): Promise<CoordinatorResumeEvent[]> {
    const promoted: CoordinatorResumeEvent[] = [];
    await this.mutate((events) =>
      events.map((event) => {
        if (
          event.state !== "armed" ||
          event.childAgentId !== params.childAgentId ||
          event.childTurnId !== params.childTurnId
        ) {
          return event;
        }
        const updatedAt = this.now().toISOString();
        if (params.currentParentAgentId !== event.coordinatorAgentId) {
          const updated = { ...event, state: "ownership_changed" as const, updatedAt };
          promoted.push(updated);
          return updated;
        }
        const outcomeId = childOutcomeId({
          childAgentId: event.childAgentId,
          childTurnId: event.childTurnId,
          eventId: event.eventId,
          outcome: params.outcome,
        });
        const duplicate = events.find(
          (candidate) =>
            candidate.eventId !== event.eventId && candidate.childOutcomeId === outcomeId,
        );
        if (duplicate) {
          throw new Error(`Child outcome ${outcomeId} is already recorded by ${duplicate.eventId}`);
        }
        const updated = {
          ...event,
          childOutcome: params.outcome,
          childOutcomeId: outcomeId,
          resultLocator: resultLocator({
            childAgentId: event.childAgentId,
            childTurnId: event.childTurnId,
            eventId: event.eventId,
          }),
          state: "pending" as const,
          nextAttemptAt: updatedAt,
          updatedAt,
        };
        promoted.push(updated);
        return updated;
      }),
    );
    return promoted;
  }

  async promoteStartFailure(eventId: string): Promise<CoordinatorResumeEvent> {
    let result: CoordinatorResumeEvent | null = null;
    await this.mutate((events) =>
      events.map((event) => {
        if (event.eventId !== eventId) return event;
        if (event.state !== "armed" || event.childTurnId !== null) {
          result = event;
          return event;
        }
        const updatedAt = this.now().toISOString();
        const updated = {
          ...event,
          childOutcome: "failed" as const,
          childOutcomeId: childOutcomeId({
            childAgentId: event.childAgentId,
            childTurnId: null,
            eventId: event.eventId,
            outcome: "failed",
          }),
          resultLocator: resultLocator({
            childAgentId: event.childAgentId,
            childTurnId: null,
            eventId: event.eventId,
          }),
          state: "pending" as const,
          nextAttemptAt: updatedAt,
          updatedAt,
        };
        result = updated;
        return updated;
      }),
    );
    if (!result) throw new Error(`Coordinator resume event not found: ${eventId}`);
    return result;
  }

  async cancelChildTurn(params: { childAgentId: string; childTurnId: string }): Promise<void> {
    await this.mutate((events) =>
      events.map((event) =>
        event.state === "armed" &&
        event.childAgentId === params.childAgentId &&
        event.childTurnId === params.childTurnId
          ? { ...event, state: "child_canceled", updatedAt: this.now().toISOString() }
          : event,
      ),
    );
  }

  async markChildPolicy(params: {
    childAgentId: string;
    childTurnId: string;
    state: "child_missing" | "child_archived";
  }): Promise<void> {
    await this.mutate((events) =>
      events.map((event) =>
        event.state === "armed" &&
        event.childAgentId === params.childAgentId &&
        event.childTurnId === params.childTurnId
          ? { ...event, state: params.state, updatedAt: this.now().toISOString() }
          : event,
      ),
    );
  }

  async leaseNext(options: LeaseCoordinatorResumeOptions): Promise<CoordinatorResumeEvent | null> {
    let leased: CoordinatorResumeEvent | null = null;
    await this.mutate((events) => {
      const now = this.now();
      const due = events
        .filter(
          (event) =>
            event.state === "pending" &&
            (event.nextAttemptAt === null || Date.parse(event.nextAttemptAt) <= now.getTime()),
        )
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
      if (!due) return events;
      const leaseId = this.idFactory();
      const updated = {
        ...due,
        state: "leased" as const,
        attempt: due.attempt + 1,
        leaseId,
        leaseExpiresAt: new Date(now.getTime() + options.leaseMs).toISOString(),
        updatedAt: now.toISOString(),
      };
      leased = updated;
      return events.map((event) => (event.eventId === due.eventId ? updated : event));
    });
    return leased;
  }

  async markDelivered(params: {
    eventId: string;
    leaseId: string;
    coordinatorTurnId: string;
  }): Promise<CoordinatorResumeEvent> {
    return this.updateLeased(params.eventId, params.leaseId, (event) => {
      const updatedAt = this.now().toISOString();
      return {
        ...event,
        state: "delivered",
        leaseId: null,
        leaseExpiresAt: null,
        coordinatorTurnId: params.coordinatorTurnId,
        deliveredAt: updatedAt,
        updatedAt,
      };
    });
  }

  async releaseLease(params: {
    eventId: string;
    leaseId: string;
  }): Promise<CoordinatorResumeEvent> {
    return this.updateLeased(params.eventId, params.leaseId, (event) => {
      const now = this.now();
      return {
        ...event,
        state: "pending",
        nextAttemptAt: new Date(now.getTime() + this.retryDelayMs(event.attempt)).toISOString(),
        leaseId: null,
        leaseExpiresAt: null,
        coordinatorTurnId: null,
        deliveredAt: null,
        updatedAt: now.toISOString(),
      };
    });
  }

  async markPolicy(params: {
    eventId: string;
    leaseId: string;
    state:
      | "child_missing"
      | "child_archived"
      | "ownership_changed"
      | "coordinator_missing"
      | "coordinator_archived"
      | "coordinator_unsupported";
  }): Promise<CoordinatorResumeEvent> {
    return this.updateLeased(params.eventId, params.leaseId, (event) => ({
      ...event,
      state: params.state,
      leaseId: null,
      leaseExpiresAt: null,
      updatedAt: this.now().toISOString(),
    }));
  }

  async recordCoordinatorTerminal(params: {
    coordinatorAgentId: string;
    coordinatorTurnId: string;
    outcome: "completed" | "failed" | "canceled";
  }): Promise<CoordinatorResumeEvent[]> {
    const changed: CoordinatorResumeEvent[] = [];
    await this.mutate((events) =>
      events.map((event) => {
        if (
          event.state !== "delivered" ||
          event.coordinatorAgentId !== params.coordinatorAgentId ||
          event.coordinatorTurnId !== params.coordinatorTurnId
        ) {
          return event;
        }
        const now = this.now();
        const updated =
          params.outcome === "completed"
            ? {
                ...event,
                state: "acked" as const,
                leaseId: null,
                leaseExpiresAt: null,
                nextAttemptAt: null,
                ackedAt: now.toISOString(),
                updatedAt: now.toISOString(),
              }
            : {
                ...event,
                state: "pending" as const,
                leaseId: null,
                leaseExpiresAt: null,
                coordinatorTurnId: null,
                deliveredAt: null,
                nextAttemptAt: new Date(
                  now.getTime() + this.retryDelayMs(event.attempt),
                ).toISOString(),
                updatedAt: now.toISOString(),
              };
        changed.push(updated);
        return updated;
      }),
    );
    return changed;
  }

  async reconcile(): Promise<CoordinatorResumeEvent[]> {
    const recovered: CoordinatorResumeEvent[] = [];
    await this.mutate((events) => {
      const now = this.now();
      return events.map((event) => {
        if (
          event.state !== "leased" ||
          event.leaseExpiresAt === null ||
          Date.parse(event.leaseExpiresAt) > now.getTime()
        ) {
          return event;
        }
        const updated = {
          ...event,
          state: "pending" as const,
          leaseId: null,
          leaseExpiresAt: null,
          coordinatorTurnId: null,
          deliveredAt: null,
          nextAttemptAt: now.toISOString(),
          updatedAt: now.toISOString(),
        };
        recovered.push(updated);
        return updated;
      });
    });
    return recovered;
  }

  async reconcileStartup(): Promise<CoordinatorResumeEvent[]> {
    const recovered = await this.reconcile();
    await this.mutate((events) =>
      events.map((event) => {
        if (event.state !== "armed" && event.state !== "delivered") return event;
        const now = this.now();
        const updated =
          event.state === "armed"
            ? {
                ...event,
                childOutcome: "failed" as const,
                childOutcomeId: childOutcomeId({
                  childAgentId: event.childAgentId,
                  childTurnId: event.childTurnId,
                  eventId: event.eventId,
                  outcome: "failed",
                }),
                resultLocator: resultLocator({
                  childAgentId: event.childAgentId,
                  childTurnId: event.childTurnId,
                  eventId: event.eventId,
                }),
                state: "pending" as const,
                nextAttemptAt: now.toISOString(),
                updatedAt: now.toISOString(),
              }
            : {
                ...event,
                state: "pending" as const,
                leaseId: null,
                leaseExpiresAt: null,
                coordinatorTurnId: null,
                deliveredAt: null,
                nextAttemptAt: now.toISOString(),
                updatedAt: now.toISOString(),
              };
        recovered.push(updated);
        return updated;
      }),
    );
    return recovered;
  }

  async nextWakeAt(): Promise<number | null> {
    const candidates = (await this.list()).flatMap((event) => {
      if (event.state === "pending" && event.nextAttemptAt) {
        return [Date.parse(event.nextAttemptAt)];
      }
      if (event.state === "leased" && event.leaseExpiresAt) {
        return [Date.parse(event.leaseExpiresAt)];
      }
      return [];
    });
    return candidates.length === 0 ? null : Math.min(...candidates);
  }

  private async updateLeased(
    eventId: string,
    leaseId: string,
    updater: (event: CoordinatorResumeEvent) => CoordinatorResumeEvent,
  ): Promise<CoordinatorResumeEvent> {
    let result: CoordinatorResumeEvent | null = null;
    await this.mutate((events) =>
      events.map((event) => {
        if (event.eventId !== eventId) return event;
        if (event.state !== "leased" || event.leaseId !== leaseId) {
          throw new Error(`Coordinator resume lease is no longer owned: ${eventId}`);
        }
        result = CoordinatorResumeEventSchema.parse(updater(event));
        return result;
      }),
    );
    if (!result) throw new Error(`Coordinator resume event not found: ${eventId}`);
    return result;
  }

  private retryDelayMs(attempt: number): number {
    return Math.min(this.maxRetryMs, this.baseRetryMs * 2 ** Math.max(0, attempt - 1));
  }

  private async read(): Promise<{ events: CoordinatorResumeEvent[] }> {
    try {
      const content = await readFile(this.filePath, "utf8");
      return CoordinatorResumeFileSchema.parse(JSON.parse(content));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { events: [] };
      }
      throw error;
    }
  }

  private async mutate(updater: EventUpdater): Promise<void> {
    const operation = this.mutationTail
      .catch(() => undefined)
      .then(async () => {
        const current = await this.read();
        const events = await updater(current.events);
        const parsed = CoordinatorResumeFileSchema.parse({ events });
        await mkdir(dirname(this.filePath), { recursive: true });
        await writeJsonFileAtomic(this.filePath, parsed);
        return undefined;
      });
    this.mutationTail = operation;
    await operation;
  }
}
