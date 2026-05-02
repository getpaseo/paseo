import {
  decodeTerminalSnapshotPayload,
  encodeTerminalResizePayload,
  encodeTerminalStreamFrame,
  TerminalStreamOpcode,
  type TerminalStreamFrame,
} from "../shared/binary-frames/index.js";
import type { TerminalInput, TerminalState } from "../shared/messages.js";

export type TerminalStreamEvent =
  | { terminalId: string; type: "output"; data: Uint8Array }
  | { terminalId: string; type: "snapshot"; state: TerminalState };

export class TerminalStreamRouter {
  private readonly terminalSlots = new Map<string, number>();
  private readonly slotTerminals = new Map<number, string>();
  private readonly listeners = new Set<(event: TerminalStreamEvent) => void>();

  onEvent(handler: (event: TerminalStreamEvent) => void): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  setSlot(terminalId: string, slot: number): void {
    const existingTerminalId = this.slotTerminals.get(slot);
    if (existingTerminalId && existingTerminalId !== terminalId) {
      this.terminalSlots.delete(existingTerminalId);
    }

    const existingSlot = this.terminalSlots.get(terminalId);
    if (typeof existingSlot === "number" && existingSlot !== slot) {
      this.slotTerminals.delete(existingSlot);
    }

    this.terminalSlots.set(terminalId, slot);
    this.slotTerminals.set(slot, terminalId);
  }

  removeTerminal(terminalId: string): void {
    const slot = this.terminalSlots.get(terminalId);
    if (typeof slot !== "number") {
      return;
    }
    this.terminalSlots.delete(terminalId);
    if (this.slotTerminals.get(slot) === terminalId) {
      this.slotTerminals.delete(slot);
    }
  }

  clearSlots(): void {
    this.terminalSlots.clear();
    this.slotTerminals.clear();
  }

  encodeInput(terminalId: string, message: TerminalInput["message"]): Uint8Array | null {
    const slot = this.terminalSlots.get(terminalId);
    if (typeof slot !== "number") {
      return null;
    }

    if (message.type === "input") {
      return encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Input,
        slot,
        payload: message.data,
      });
    }

    if (message.type === "resize") {
      return encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Resize,
        slot,
        payload: encodeTerminalResizePayload({
          rows: message.rows,
          cols: message.cols,
        }),
      });
    }

    return null;
  }

  handleFrame(frame: TerminalStreamFrame): void {
    const terminalId = this.slotTerminals.get(frame.slot);
    if (!terminalId) {
      return;
    }

    if (frame.opcode === TerminalStreamOpcode.Output) {
      this.emit({
        terminalId,
        type: "output",
        data: frame.payload,
      });
      return;
    }

    if (frame.opcode === TerminalStreamOpcode.Snapshot) {
      const state = decodeTerminalSnapshotPayload(frame.payload);
      if (!state) {
        return;
      }
      this.emit({
        terminalId,
        type: "snapshot",
        state,
      });
    }
  }

  private emit(event: TerminalStreamEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // no-op
      }
    }
  }
}
