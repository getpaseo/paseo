import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { InstructionFileWriter, readInstructionFile } from "./storage.js";
import {
  HOST_INSTRUCTION_TTL_MS,
  HostInstructionSchema,
  HostInstructionStateSchema,
  type HostInstruction,
} from "./inbox.js";

export const HostInstructionReceiptSchema = z.object({
  id: z.uuid(),
  state: HostInstructionStateSchema,
  reply: z.string().max(32_768).optional(),
});
const Outgoing = z.object({
  registrationId: z.string().min(1).max(256),
  instruction: HostInstructionSchema,
  attempted: z.boolean(),
  cancellationPending: z.boolean(),
  receipt: HostInstructionReceiptSchema.optional(),
});
const OutboxFile = z.array(Outgoing);

type OutgoingInstruction = z.infer<typeof Outgoing>;
type InstructionReceipt = z.infer<typeof HostInstructionReceiptSchema>;

export interface HostInstructionTransport {
  // A missing receipt indicates that the target cannot confirm the operation yet.
  submit(registrationId: string, instruction: HostInstruction): Promise<InstructionReceipt | null>;
  status(registrationId: string, id: string, expiresAt: number): Promise<InstructionReceipt | null>;
  // A confirmed cancellation must also prevent late submissions with the same id.
  cancel(registrationId: string, instruction: HostInstruction): Promise<InstructionReceipt | null>;
}

function terminal(state: InstructionReceipt["state"] | undefined): boolean {
  return (
    state !== undefined &&
    state !== "awaiting_approval" &&
    state !== "queued" &&
    state !== "dispatching" &&
    state !== "running"
  );
}

/** The daemon's connection scheduler calls flush when a registration is reachable. */
export class HostInstructionOutbox {
  private readonly flushing = new Map<string, Promise<void>>();

  private constructor(
    private requests: OutgoingInstruction[],
    private readonly writer: InstructionFileWriter,
    private readonly transport: HostInstructionTransport,
    private readonly now: () => number,
  ) {}

  static async open(
    paseoHome: string,
    transport: HostInstructionTransport,
    now: () => number = Date.now,
  ) {
    const file = path.join(paseoHome, "host-instructions", "outbox.json");
    const requests = await readInstructionFile(file, OutboxFile.parse, []);
    return new HostInstructionOutbox(requests, new InstructionFileWriter(file), transport, now);
  }

  async submit(registrationId: string, input: Pick<HostInstruction, "target" | "prompt">) {
    const request = Outgoing.parse({
      registrationId,
      instruction: {
        ...input,
        id: randomUUID(),
        expiresAt: this.now() + HOST_INSTRUCTION_TTL_MS,
      },
      attempted: false,
      cancellationPending: false,
    });
    await this.commit([...this.requests, request]);
    return this.status(request.instruction.id);
  }

  async status(id: string) {
    await this.writer.settled();
    const request = this.requireRequest(id);
    if (!request.attempted && !request.receipt && this.now() >= request.instruction.expiresAt) {
      await this.update(id, { receipt: { id, state: "expired" } });
      return { id, state: "expired" as const, cancellationPending: false };
    }
    return {
      id,
      state: request.receipt?.state ?? "waiting_for_host",
      cancellationPending: request.cancellationPending,
      reply: request.receipt?.reply,
    };
  }

  async cancel(id: string) {
    const status = await this.status(id);
    if (terminal(this.requireRequest(id).receipt?.state) || status.state === "running")
      return status;
    if (this.requireRequest(id).attempted) {
      await this.update(id, { cancellationPending: true });
    } else {
      await this.update(id, { receipt: { id, state: "cancelled" } });
    }
    return this.status(id);
  }

  pendingRegistrations(): string[] {
    return [
      ...new Set(
        this.requests
          .filter((request) => !terminal(request.receipt?.state))
          .map((request) => request.registrationId),
      ),
    ];
  }

  flush(registrationId: string): Promise<void> {
    const pending = this.flushing.get(registrationId);
    if (pending) return pending;
    const operation = this.deliver(registrationId).finally(() => {
      this.flushing.delete(registrationId);
    });
    this.flushing.set(registrationId, operation);
    return operation;
  }

  private async deliver(registrationId: string): Promise<void> {
    for (const request of this.requests.filter(
      (entry) => entry.registrationId === registrationId,
    )) {
      const id = request.instruction.id;
      await this.status(id);
      const current = this.requireRequest(id);
      if (terminal(current.receipt?.state)) continue;

      let receipt: InstructionReceipt | null;
      if (current.cancellationPending) {
        receipt = await this.transport.cancel(registrationId, current.instruction);
      } else if (current.receipt || this.now() >= current.instruction.expiresAt) {
        receipt = await this.transport.status(registrationId, id, current.instruction.expiresAt);
      } else {
        if (!current.attempted) await this.update(id, { attempted: true });
        receipt = await this.transport.submit(registrationId, current.instruction);
      }

      if (receipt) {
        const confirmed = HostInstructionReceiptSchema.parse(receipt);
        if (confirmed.id !== id) throw new Error("Response belongs to a different instruction");
        const cancellationPending =
          this.requireRequest(id).cancellationPending &&
          !terminal(confirmed.state) &&
          confirmed.state !== "running";
        await this.update(id, { receipt: confirmed, cancellationPending });
      }
    }
  }

  private requireRequest(id: string): OutgoingInstruction {
    const request = this.requests.find((entry) => entry.instruction.id === id);
    if (!request) throw new Error("Outgoing instruction does not exist");
    return request;
  }

  private async update(id: string, changes: Partial<OutgoingInstruction>): Promise<void> {
    await this.commit(
      this.requests.map((entry) =>
        entry.instruction.id === id ? { ...entry, ...changes } : entry,
      ),
    );
  }

  private async commit(requests: OutgoingInstruction[]): Promise<void> {
    this.requests = requests;
    await this.writer.persist(requests);
  }
}
