import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { authServerBaseUrl } from "@/api/auth-server-fetch";
import { useAuthSession } from "./use-auth-session";

/**
 * Subscribes to the auth-server's `/api/billing/stream` SSE feed for the
 * current user and invalidates the React Query caches that hold plan data
 * whenever a `billing.updated` event arrives.
 *
 * Why SSE and not polling: when a user clicks "Upgrade to Pro", they jump
 * to Stripe in the browser, pay, and bounce back to the desktop. With a
 * 60s `staleTime` on `useOrganizations`, the UI keeps showing "Free" for
 * up to a minute. Pushing the change from the webhook flips the UI within
 * a network round-trip.
 *
 * The connection is per-session (Bearer token in the Authorization header),
 * so we use fetch + ReadableStream rather than the EventSource API — the
 * latter can't set headers. Reconnects with exponential backoff (capped at
 * 30s) so a flaky network or auth-server restart doesn't permanently kill
 * the channel.
 */
export function useBillingStream(): void {
  const queryClient = useQueryClient();
  const { isAuthenticated, session } = useAuthSession();
  const sessionToken = isAuthenticated ? (session?.sessionToken ?? null) : null;

  useEffect(() => {
    if (!sessionToken) return;

    const controller = new AbortController();
    let cancelled = false;
    let reconnectDelayMs = 1000;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = async () => {
      while (!cancelled) {
        try {
          const response = await fetch(`${authServerBaseUrl()}/api/billing/stream`, {
            method: "GET",
            credentials: "include",
            headers: {
              Authorization: `Bearer ${sessionToken}`,
              Accept: "text/event-stream",
            },
            signal: controller.signal,
          });

          if (!response.ok || !response.body) {
            // 401/403 on a stale token will keep failing — back off harder so
            // we don't hammer the server while the user is signed out.
            throw new Error(`billing-stream HTTP ${response.status}`);
          }

          // Successful connect — reset backoff for the next disconnect.
          reconnectDelayMs = 1000;

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

          while (!cancelled) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            // SSE frames are separated by a blank line.
            let sepIdx: number;
            while ((sepIdx = buffer.indexOf("\n\n")) !== -1) {
              const frame = buffer.slice(0, sepIdx);
              buffer = buffer.slice(sepIdx + 2);
              handleFrame(frame);
            }
          }
        } catch (err) {
          if (cancelled || controller.signal.aborted) return;
          // Connection dropped — log once at debug volume and reconnect.
          if (__DEV__) {
            console.warn("[billing-stream] disconnected, reconnecting", err);
          }
        }

        if (cancelled) return;
        await new Promise<void>((resolve) => {
          reconnectTimer = setTimeout(resolve, reconnectDelayMs);
        });
        reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30_000);
      }
    };

    const handleFrame = (frame: string) => {
      // We only act on the data — `event:` line is informational. Any
      // billing-related frame from the server means "your plan may have
      // changed, refetch."
      if (!frame.includes("data:")) return;
      // Ignore the initial `ready` event so we don't spam invalidations on
      // reconnect storms.
      if (frame.startsWith("event: ready")) return;
      // Plan changed → orgs (carry planId) AND the Hubcode model bundle
      // (combos vary per plan, free → empty + requiresUpgrade) both go stale.
      // Without invalidating hubcodeModels, the picker keeps showing the
      // pre-upgrade (empty) list for up to staleTime after a Free→Pro flip.
      void queryClient.invalidateQueries({ queryKey: ["desktopOrganizations"] });
      void queryClient.invalidateQueries({ queryKey: ["hubcodeModels"] });
    };

    void connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      controller.abort();
    };
  }, [sessionToken, queryClient]);
}
