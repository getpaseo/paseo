import type { SerialPort, SerialBrowser } from "./session";
import { getSerialBrowser } from "./web";

// Typed hardware port for browser E2E tests. The real RPC/network path is retained.
export function getFakeSerialBrowser(
  mode: "echo" | "cancel" | "open-failure" = "echo",
): SerialBrowser {
  return {
    ...getSerialBrowser(),
    unavailable: null,
    requestPort: async () => {
      if (mode === "cancel") throw new Error("No port selected.");
      const port = new EchoSerialPort();
      if (mode === "open-failure") {
        port.open = async () => {
          throw new Error("The serial device is already in use.");
        };
      }
      return port;
    },
  };
}

class EchoSerialPort implements SerialPort {
  private queue: Uint8Array[] = [new Uint8Array([82, 69, 65, 68, 89, 0, 255])];
  private pending?: (result: { done: boolean; value?: Uint8Array }) => void;
  private closed = false;
  private readerLocked = false;
  private writerLocked = false;
  getInfo() {
    return { usbVendorId: 0x1209, usbProductId: 1 };
  }
  async open() {
    this.closed = false;
  }
  async close() {
    if (this.readerLocked || this.writerLocked) throw new Error("Serial stream is locked");
    this.closed = true;
  }
  async forget() {}
  readable = {
    getReader: () => {
      if (this.readerLocked) throw new Error("Reader already locked");
      this.readerLocked = true;
      return {
        read: async (): Promise<{ done: boolean; value?: Uint8Array }> => {
          if (this.closed) return { done: true };
          const value = this.queue.shift();
          if (value) return { done: false, value };
          return new Promise((resolve) => {
            this.pending = resolve;
          });
        },
        cancel: async () => {
          this.closed = true;
          this.pending?.({ done: true });
          this.pending = undefined;
        },
        releaseLock: () => {
          this.readerLocked = false;
        },
      };
    },
  };
  writable = {
    getWriter: () => {
      if (this.writerLocked) throw new Error("Writer already locked");
      this.writerLocked = true;
      return {
        write: async (data: Uint8Array) => {
          const value = data.slice();
          if (this.pending) {
            this.pending({ done: false, value });
            this.pending = undefined;
          } else this.queue.push(value);
        },
        abort: async () => {},
        releaseLock: () => {
          this.writerLocked = false;
        },
      };
    },
  };
}
