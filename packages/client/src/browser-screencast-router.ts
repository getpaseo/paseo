import type {
  BrowserScreencastFrame,
  BrowserScreencastMetadata,
} from "@getpaseo/protocol/binary-frames/index";

export interface BrowserScreencastEvent {
  browserId: string;
  metadata: BrowserScreencastMetadata;
  data: Uint8Array;
}

export class BrowserScreencastRouter {
  private readonly slotsByBrowserId = new Map<string, number>();
  private readonly browserIdsBySlot = new Map<number, string>();
  private readonly listeners = new Set<(event: BrowserScreencastEvent) => void>();

  onEvent(handler: (event: BrowserScreencastEvent) => void): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  setSlot(browserId: string, slot: number): void {
    const previousBrowserId = this.browserIdsBySlot.get(slot);
    if (previousBrowserId && previousBrowserId !== browserId) {
      this.slotsByBrowserId.delete(previousBrowserId);
    }

    const previousSlot = this.slotsByBrowserId.get(browserId);
    if (typeof previousSlot === "number" && previousSlot !== slot) {
      this.browserIdsBySlot.delete(previousSlot);
    }

    this.slotsByBrowserId.set(browserId, slot);
    this.browserIdsBySlot.set(slot, browserId);
  }

  removeBrowser(browserId: string): void {
    const slot = this.slotsByBrowserId.get(browserId);
    if (typeof slot !== "number") {
      return;
    }
    this.slotsByBrowserId.delete(browserId);
    if (this.browserIdsBySlot.get(slot) === browserId) {
      this.browserIdsBySlot.delete(slot);
    }
  }

  clearSlots(): void {
    this.slotsByBrowserId.clear();
    this.browserIdsBySlot.clear();
  }

  handleFrame(frame: BrowserScreencastFrame): void {
    const browserId = this.browserIdsBySlot.get(frame.slot);
    if (!browserId) {
      return;
    }
    const event: BrowserScreencastEvent = {
      browserId,
      metadata: frame.metadata,
      data: frame.payload,
    };
    this.emit(event);
  }

  private emit(event: BrowserScreencastEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // One pane throwing must not stop the frame reaching the others.
      }
    }
  }
}
