import {
  TerminalStreamOpcode,
  TerminalReplayMetadataSchema,
  type TerminalStreamFrame,
} from "@getpaseo/protocol/binary-frames/index";

export type TerminalReplayEvent =
  | { type: "begin"; rows?: number; cols?: number; retainedHistoryLines?: number }
  | { type: "data"; data: Uint8Array }
  | { type: "end" };

export type TerminalStreamEvent = { terminalId: string; subscriptionId: string } & (
  | { type: "output"; data: Uint8Array }
  | { type: "replay"; replay: TerminalReplayEvent }
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
      else if (frame.opcode === TerminalStreamOpcode.Restore) {
        // COMPAT(terminalSingleRestore): added after v0.14.0; remove when ANSI host floor supports chunked replay after 2027-04-30.
        for (const replay of [
          { type: "begin" },
          { type: "data", data: frame.payload },
          { type: "end" },
        ] as TerminalReplayEvent[])
          this.deliver(registration.receive, { ...identity, type: "replay", replay });
        continue;
      } else if (frame.opcode === TerminalStreamOpcode.ReplayBegin) {
        let raw: unknown;
        try {
          raw = JSON.parse(new TextDecoder().decode(frame.payload));
        } catch {
          return;
        }
        const parsed = TerminalReplayMetadataSchema.safeParse(raw);
        if (!parsed.success) return;
        const metadata = parsed.data;
        event = { ...identity, type: "replay", replay: { type: "begin", ...metadata } };
      } else if (frame.opcode === TerminalStreamOpcode.ReplayData)
        event = { ...identity, type: "replay", replay: { type: "data", data: frame.payload } };
      else if (frame.opcode === TerminalStreamOpcode.ReplayEnd)
        event = { ...identity, type: "replay", replay: { type: "end" } };
      else return;
      this.deliver(registration.receive, event);
    }
  }

  private deliver(receive: (event: TerminalStreamEvent) => void, event: TerminalStreamEvent): void {
    receive(event);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* Passive diagnostics cannot interrupt delivery. */
      }
    }
  }
}
