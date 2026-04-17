"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function BillingSuccessPage() {
  const router = useRouter();
  const [countdown, setCountdown] = useState(5);
  const [synced, setSynced] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function syncSubscription(attempt = 1): Promise<void> {
      try {
        const res = await fetch("/api/billing/sync", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: res.statusText }));
          if (!cancelled && attempt < 3) {
            await new Promise((resolve) => setTimeout(resolve, 2000));
            return syncSubscription(attempt + 1);
          }
          if (!cancelled) {
            setSyncError(`Sync failed: ${err.error || res.statusText}`);
            setSynced(true);
          }
          return;
        }

        const data = await res.json();
        if (!data.synced && !cancelled && attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          return syncSubscription(attempt + 1);
        }

        if (!cancelled) {
          if (!data.synced) {
            setSyncError(`Could not sync: ${data.reason}`);
          }
          setSynced(true);
        }
      } catch {
        if (!cancelled && attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          return syncSubscription(attempt + 1);
        }
        if (!cancelled) {
          setSyncError("Network error syncing subscription");
          setSynced(true);
        }
      }
    }

    void syncSubscription();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!synced) return;

    const timer = window.setInterval(() => {
      setCountdown((current) => (current <= 1 ? 0 : current - 1));
    }, 1000);

    return () => window.clearInterval(timer);
  }, [synced]);

  useEffect(() => {
    if (synced && countdown === 0) {
      router.push("/dashboard/billing");
    }
  }, [synced, countdown, router]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="max-w-md space-y-6 text-center">
        <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full border-2 border-primary/30 bg-primary/10">
          <svg
            className="h-10 w-10 text-primary"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M5 13l4 4L19 7" />
          </svg>
        </div>

        <div className="space-y-2">
          <h1 className="text-2xl font-semibold text-foreground">Subscription activated!</h1>
          <p className="text-muted-foreground">
            Your account plan was updated successfully and the new limits are now available for your
            organizations.
          </p>
        </div>

        <div className="space-y-3 pt-2">
          <button
            type="button"
            onClick={() => router.push("/dashboard/billing")}
            className="inline-flex h-11 items-center justify-center rounded-lg bg-primary px-5 text-sm font-medium text-primary-foreground transition-colors hover:brightness-110"
          >
            View your billing
          </button>
          <p className="text-xs text-muted-foreground/60">
            {!synced
              ? "Syncing subscription..."
              : syncError
                ? syncError
                : `Redirecting in ${countdown}s...`}
          </p>
        </div>
      </div>
    </div>
  );
}
