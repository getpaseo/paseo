import { describe, expect, it, vi } from "vitest";
import {
  PLUGIN_PROCESS_SEND_TIMEOUT_MS,
  sendPluginProcessMessage,
} from "./bounded-process-send.js";

describe("bounded plugin process sends", () => {
  it("rejects when the child IPC callback never settles", async () => {
    vi.useFakeTimers();
    try {
      let callback: ((error?: Error | null) => void) | undefined;
      const sending = sendPluginProcessMessage(
        (_message: { type: string }, acknowledge) => {
          callback = acknowledge;
          return true;
        },
        { type: "invoke" },
      );
      void sending.catch(() => undefined);

      await vi.advanceTimersByTimeAsync(PLUGIN_PROCESS_SEND_TIMEOUT_MS);
      await expect(sending).rejects.toThrow("IPC send timed out");
      callback?.();
    } finally {
      vi.useRealTimers();
    }
  });
});
