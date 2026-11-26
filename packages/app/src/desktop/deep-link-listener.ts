import { useEffect } from "react";
import { listenToDesktopEvent } from "@/desktop/electron/events";
import { getDesktopHost, type DesktopHostBridge } from "@/desktop/host";

export interface DesktopDeepLinkListener<TPayload> {
  /** The event desktop main sends once this window is ready. */
  event: string;
  /** The bridge call that returns the link main queued while this window loaded. */
  readyCall: (host: DesktopHostBridge) => (() => Promise<TPayload | null>) | undefined;
  open: (payload: TPayload | null) => void;
}

/** Opens deep links that desktop main routes to this window, including one queued at startup. */
export function useDesktopDeepLinkListener<TPayload>({
  event,
  readyCall,
  open,
}: DesktopDeepLinkListener<TPayload>): void {
  useEffect(() => {
    const host = getDesktopHost();
    const ready = host ? readyCall(host) : undefined;
    if (typeof host?.events?.on !== "function" || typeof ready !== "function") {
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = async () => {
      let dispose: (() => void) | null = null;
      try {
        dispose = await listenToDesktopEvent<TPayload | null>(event, open);
        if (disposed) {
          dispose();
          return;
        }
        unlisten = dispose;
        const pending = await ready();
        if (!disposed && pending) {
          open(pending);
        }
      } catch {
        dispose?.();
        if (unlisten === dispose) {
          unlisten = null;
        }
        if (!disposed) {
          retryTimer = setTimeout(() => void connect(), 1_000);
        }
      }
    };

    void connect();

    return () => {
      disposed = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
      unlisten?.();
    };
  }, [event, readyCall, open]);
}
