import {
  decodeTerminalSnapshotPayload,
  TerminalStreamOpcode,
  type TerminalStreamFrame,
} from "@getpaseo/protocol/binary-frames/index";
import type { TerminalState } from "@getpaseo/protocol/messages";

export type TerminalStreamEvent = { terminalId: string; subscriptionId: string } & (
  | { type: "output"; data: Uint8Array }
  | { type: "snapshot"; state: TerminalState }
  | { type: "restore"; data: Uint8Array }
);

export class TerminalStreamRouter {
  private readonly slots = new Map<
    number,
    Set<{
      subscriptionId: string;
      terminalId: string;
      receive: (event: TerminalStreamEvent) => void;
    }>
  >();
  private readonly listeners = new Set<(event: TerminalStreamEvent) => void>();

  /** Passive wire diagnostics. App state consumes the registration's callback. */
  onEvent(handler: (event: TerminalStreamEvent) => void): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  attach(
    subscriptionId: string,
    terminalId: string,
    slot: number,
    receive: (event: TerminalStreamEvent) => void,
  ): () => void {
    const registration = { subscriptionId, terminalId, receive };
    const registrations = this.slots.get(slot) ?? new Set();
    registrations.add(registration);
    this.slots.set(slot, registrations);
    return () => {
      registrations.delete(registration);
      if (registrations.size === 0) this.slots.delete(slot);
    };
  }

  clearSlots(): void {
    this.slots.clear();
  }

  handleFrame(frame: TerminalStreamFrame): void {
    const registrations = this.slots.get(frame.slot);
    if (!registrations) return;
    for (const registration of registrations) {
      const identity = {
        subscriptionId: registration.subscriptionId,
        terminalId: registration.terminalId,
      };
      let event: TerminalStreamEvent;
      if (frame.opcode === TerminalStreamOpcode.Output)
        event = { ...identity, type: "output", data: frame.payload };
      else if (frame.opcode === TerminalStreamOpcode.Restore)
        event = { ...identity, type: "restore", data: frame.payload };
      else if (frame.opcode === TerminalStreamOpcode.Snapshot) {
        const state = decodeTerminalSnapshotPayload(frame.payload);
        if (!state) return;
        event = { ...identity, type: "snapshot", state };
      } else return;
      registration.receive(event);
      for (const listener of this.listeners) {
        try {
          listener(event);
        } catch {
          /* Passive diagnostics cannot interrupt delivery. */
        }
      }
    }
  }
}
