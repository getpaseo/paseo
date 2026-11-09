import { expect, it, vi } from "vitest";
import { exportPublicKey, generateKeyPair } from "./crypto.js";
import type { Transport } from "./encrypted-channel.js";
import { openClientSecureChannel } from "./secure-channel.js";

/** A socket whose peer never acknowledges the close handshake. */
class UnresponsiveTransport implements Transport {
  onmessage: Transport["onmessage"] = null;
  onclose: Transport["onclose"] = null;
  onerror: Transport["onerror"] = null;
  sends = 0;
  closing = false;

  send(): void {
    this.sends += 1;
    if (this.closing) throw new Error("WebSocket not open (readyState=2)");
  }

  close(): void {
    this.closing = true;
  }
}

it.each(["client close", "handshake rejection"] as const)(
  "stops handshake retries after %s without a socket acknowledgment",
  async (trigger) => {
    vi.useFakeTimers();
    const transport = new UnresponsiveTransport();
    const errors: Error[] = [];
    let closed = 0;
    try {
      const channel = await openClientSecureChannel(transport, {
        daemonPublicKeyB64: exportPublicKey(generateKeyPair().publicKey),
        minimumMode: "protected",
        events: { onerror: (error) => errors.push(error) },
      });
      channel.onClose(() => closed++);

      // The handshake still retries while the connection is wanted.
      await vi.advanceTimersByTimeAsync(2_000);
      expect(transport.sends).toBe(3);
      if (trigger === "client close") {
        channel.close();
      } else {
        transport.onmessage?.({ data: JSON.stringify({ type: "e2ee_ready" }), isBinary: false });
      }
      await vi.advanceTimersByTimeAsync(5_000);

      expect(transport.sends).toBe(3);
      expect(errors).toHaveLength(trigger === "client close" ? 0 : 1);
      expect(closed).toBe(1);
      // A late socket acknowledgment does not close the channel a second time.
      transport.onclose?.(1000, "Normal closure");
      expect(closed).toBe(1);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  },
);
