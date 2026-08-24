import { z } from "zod";
import { getDesktopHost, type DesktopHostBridge } from "@/desktop/host";

const HostScreencastFramePayloadSchema = z.object({
  slot: z.number().int().min(0).max(255),
  metadata: z.object({
    deviceWidth: z.number().positive(),
    deviceHeight: z.number().positive(),
  }),
  data: z.instanceof(Uint8Array),
});

interface BrowserScreencastFrameClient {
  sendBrowserScreencastFrame: (input: {
    slot: number;
    metadata: { deviceWidth: number; deviceHeight: number };
    data: Uint8Array;
  }) => void;
}

/** Mounted only on the host that owns the guest, never on a viewer. */
export function mountBrowserScreencastForwarder(
  client: BrowserScreencastFrameClient,
  getHost: () => DesktopHostBridge | null = getDesktopHost,
): () => void {
  const subscribe = getHost()?.events?.on;
  if (!subscribe) {
    return () => {};
  }

  let disposed = false;
  let unsubscribe: (() => void) | null = null;

  void (async () => {
    const off = await subscribe("browser-screencast-frame", (payload) => {
      const frame = HostScreencastFramePayloadSchema.safeParse(payload);
      if (frame.success) {
        client.sendBrowserScreencastFrame(frame.data);
      }
    });
    if (disposed) {
      off();
      return;
    }
    unsubscribe = off;
  })();

  return () => {
    disposed = true;
    unsubscribe?.();
    unsubscribe = null;
  };
}
