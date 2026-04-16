"use client";

import { useState } from "react";

interface Plan {
  id: string;
  name: string;
  slug: string;
  stripeMonthlyPriceId: string | null;
  stripeYearlyPriceId: string | null;
  monthlyPriceCents: number;
  yearlyPriceCents: number;
  features: Record<string, string>;
}

interface BillingPageClientProps {
  accountName: string;
  currentPlanId: string;
  currentPlan: { name: string; monthlyPriceCents: number; yearlyPriceCents: number } | null;
  billingInterval: string;
  hasStripeCustomer: boolean;
  plans: Plan[];
  success: boolean;
  canceled: boolean;
}

const FEATURE_LABELS: Record<string, string> = {
  max_members: "Team members",
  max_organizations: "Organizations",
  max_projects: "Projects",
  max_sessions: "Concurrent sessions",
  priority_support: "Priority support",
  custom_branding: "Custom branding",
  api_access: "API access",
  audit_log: "Audit log",
};

const PLAN_PRIORITY: Record<string, number> = {
  plan_free: 0,
  plan_pro: 1,
  plan_enterprise: 2,
};

function formatFeatureValue(key: string, value: string): { text: string; included: boolean } {
  if (value === "true") return { text: "", included: true };
  if (value === "false") return { text: "", included: false };
  if (value === "unlimited") return { text: "Unlimited", included: true };
  const num = parseInt(value);
  if (!isNaN(num)) return { text: `Up to ${num}`, included: true };
  return { text: value, included: true };
}

export function BillingPageClient({
  accountName,
  currentPlanId,
  currentPlan,
  billingInterval,
  hasStripeCustomer,
  plans,
  success,
  canceled,
}: BillingPageClientProps) {
  const [interval, setInterval] = useState<"monthly" | "yearly">(
    billingInterval === "yearly" ? "yearly" : "monthly",
  );
  const [loading, setLoading] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false);

  const handleCheckout = async (planId: string) => {
    setActionError(null);
    setLoading(planId);
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId, interval }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to start checkout");
      }
      if (data.url) window.location.href = data.url;
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Failed to start checkout");
    } finally {
      setLoading(null);
    }
  };

  const handlePortal = async () => {
    setActionError(null);
    setLoading("portal");
    try {
      const res = await fetch("/api/billing/portal", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to open billing portal");
      }
      if (data.url) window.location.href = data.url;
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Failed to open billing portal");
    } finally {
      setLoading(null);
    }
  };

  const handleCancelPlan = async () => {
    setActionError(null);
    setLoading("cancel");
    try {
      const res = await fetch("/api/billing/cancel", {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Failed to cancel subscription");
      }
      setCancelConfirmOpen(false);
      window.location.href = "/dashboard/billing?success=true";
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Failed to cancel subscription");
    } finally {
      setLoading(null);
    }
  };

  const handleSync = async () => {
    setActionError(null);
    setSyncing(true);
    try {
      const res = await fetch("/api/billing/sync", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json();
      console.log("[billing/sync]", data);
      if (data.synced) {
        window.location.reload();
      } else {
        setActionError(`Sync failed: ${data.reason || "Unknown error"}`);
      }
    } catch (err) {
      console.error("[billing/sync] error:", err);
      setActionError("Failed to sync subscription");
    } finally {
      setSyncing(false);
    }
  };

  const getPrice = (p: Plan) => (interval === "yearly" ? p.yearlyPriceCents : p.monthlyPriceCents);
  const getMonthlyEquivalent = (p: Plan) =>
    interval === "yearly" && p.yearlyPriceCents > 0 ? p.yearlyPriceCents / 12 : p.monthlyPriceCents;
  const hasPriceForInterval = (p: Plan) =>
    interval === "yearly" ? !!p.stripeYearlyPriceId : !!p.stripeMonthlyPriceId;
  const currentPlanPriority = PLAN_PRIORITY[currentPlanId] ?? 0;

  const allFeatureKeys = Array.from(new Set(plans.flatMap((p) => Object.keys(p.features))));

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-lg font-semibold text-foreground">Billing & Plans</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage the subscription for {accountName}
        </p>
      </div>

      {success && (
        <div className="rounded-lg border border-green-500/30 bg-green-500/10 px-4 py-3 text-sm text-green-400">
          Subscription updated successfully!
        </div>
      )}
      {canceled && (
        <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-4 py-3 text-sm text-yellow-400">
          Checkout was canceled.
        </div>
      )}
      {actionError && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {actionError}
        </div>
      )}

      {/* Current plan summary */}
      <div className="rounded-lg border border-border bg-card p-5 flex items-center justify-between">
        <div>
          <p className="text-xs text-muted-foreground uppercase tracking-wider">Current plan</p>
          <p className="mt-1 text-foreground font-medium">
            {currentPlan?.name ?? "Free"}
            {currentPlan && currentPlan.monthlyPriceCents > 0 && (
              <span className="text-muted-foreground font-normal ml-2 text-sm">
                {billingInterval === "yearly"
                  ? `$${(currentPlan.yearlyPriceCents / 100).toFixed(0)}/yr`
                  : `$${(currentPlan.monthlyPriceCents / 100).toFixed(0)}/mo`}
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleSync}
            disabled={syncing}
            className="rounded-md border border-border px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            {syncing ? "Syncing..." : "Sync from Stripe"}
          </button>
          {hasStripeCustomer && (
            <button
              type="button"
              onClick={handlePortal}
              disabled={loading === "portal"}
              className="rounded-md bg-secondary px-3 py-2 text-sm text-secondary-foreground transition-colors hover:brightness-110 disabled:opacity-50"
            >
              {loading === "portal" ? "Loading..." : "Manage billing"}
            </button>
          )}
          {currentPlanId !== "plan_free" && (
            <button
              type="button"
              onClick={() => setCancelConfirmOpen(true)}
              disabled={loading === "cancel"}
              className="rounded-md border border-red-500/30 px-3 py-2 text-sm text-red-400 transition-colors hover:bg-red-500/10 disabled:opacity-50"
            >
              {loading === "cancel" ? "Canceling..." : "Cancel plan"}
            </button>
          )}
        </div>
      </div>

      {/* Interval toggle */}
      <div className="flex items-center justify-center">
        <div className="inline-flex items-center rounded-lg border border-border bg-card p-1 gap-0.5">
          <button
            onClick={() => setInterval("monthly")}
            className={`rounded-md px-5 py-1.5 text-sm font-medium transition-colors ${
              interval === "monthly"
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Monthly
          </button>
          <button
            onClick={() => setInterval("yearly")}
            className={`rounded-md px-5 py-1.5 text-sm font-medium transition-colors ${
              interval === "yearly"
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Yearly
          </button>
        </div>
      </div>

      {/* Comparison table */}
      <div className="rounded-lg border border-border overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border">
              <th className="p-4 text-left text-sm font-normal text-muted-foreground w-[200px]" />
              {plans.map((p) => {
                const isCurrent = p.id === currentPlanId;
                const price = getPrice(p);
                const monthlyEq = getMonthlyEquivalent(p);
                return (
                  <th key={p.id} className="p-4 text-left min-w-[180px]">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-foreground">{p.name}</span>
                        {isCurrent && (
                          <span className="rounded-full bg-primary/15 border border-primary/20 px-2 py-0.5 text-[10px] font-medium text-primary">
                            Current
                          </span>
                        )}
                      </div>
                      {price === 0 ? (
                        <p className="text-2xl font-semibold text-foreground">$0</p>
                      ) : (
                        <div>
                          <p className="text-2xl font-semibold text-foreground">
                            ${(monthlyEq / 100).toFixed(0)}
                            <span className="text-sm font-normal text-muted-foreground">/mo</span>
                          </p>
                          {interval === "yearly" && (
                            <p className="text-[11px] text-muted-foreground">
                              billed ${(price / 100).toFixed(0)} annually
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>

          <tbody>
            {allFeatureKeys.map((key, i) => (
              <tr
                key={key}
                className={i < allFeatureKeys.length - 1 ? "border-b border-border/50" : ""}
              >
                <td className="px-4 py-3 text-sm text-muted-foreground">
                  {FEATURE_LABELS[key] ?? key.replace(/_/g, " ")}
                </td>
                {plans.map((p) => {
                  const raw = p.features[key];
                  if (!raw) {
                    return (
                      <td key={p.id} className="px-4 py-3 text-sm text-muted-foreground/40">
                        &mdash;
                      </td>
                    );
                  }
                  const { text, included } = formatFeatureValue(key, raw);
                  return (
                    <td key={p.id} className="px-4 py-3 text-sm">
                      {text ? (
                        <span className={included ? "text-foreground" : "text-muted-foreground/40"}>
                          {text}
                        </span>
                      ) : included ? (
                        <svg
                          className="h-4 w-4 text-primary"
                          viewBox="0 0 16 16"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                        >
                          <path
                            d="M3 8.5l3.5 3.5L13 4.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      ) : (
                        <span className="text-muted-foreground/30">&mdash;</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>

          <tfoot>
            <tr className="border-t border-border">
              <td className="p-4" />
              {plans.map((p) => {
                const isCurrent = p.id === currentPlanId;
                const price = getPrice(p);
                const planPriority = PLAN_PRIORITY[p.id] ?? 0;
                const isDowngrade = planPriority < currentPlanPriority;
                const isFreeDowngrade = p.id === "plan_free" && currentPlanId !== "plan_free";
                return (
                  <td key={p.id} className="p-4">
                    {isCurrent ? (
                      <span className="block text-center rounded-lg border border-border py-2 text-sm text-muted-foreground">
                        Current plan
                      </span>
                    ) : isFreeDowngrade ? (
                      <button
                        type="button"
                        onClick={() => setCancelConfirmOpen(true)}
                        disabled={loading === "cancel"}
                        className="block w-full rounded-lg border border-red-500/30 px-4 py-2 text-sm font-medium text-red-400 transition-colors hover:bg-red-500/10 disabled:opacity-50"
                      >
                        {loading === "cancel" ? "Canceling..." : "Downgrade to Free"}
                      </button>
                    ) : isDowngrade ? (
                      <button
                        type="button"
                        onClick={handlePortal}
                        disabled={loading === "portal"}
                        className="block w-full rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-50"
                      >
                        {loading === "portal" ? "Loading..." : "Downgrade"}
                      </button>
                    ) : hasPriceForInterval(p) ? (
                      <button
                        type="button"
                        onClick={() => handleCheckout(p.id)}
                        disabled={loading === p.id}
                        className="block w-full rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:brightness-110 disabled:opacity-50"
                      >
                        {loading === p.id ? "Loading..." : "Upgrade"}
                      </button>
                    ) : price === 0 ? (
                      <span className="block text-center rounded-lg border border-border py-2 text-sm text-muted-foreground">
                        Free
                      </span>
                    ) : (
                      <button
                        type="button"
                        disabled
                        className="block w-full rounded-lg bg-secondary px-4 py-2 text-sm font-medium text-secondary-foreground opacity-70"
                      >
                        Contact us
                      </button>
                    )}
                  </td>
                );
              })}
            </tr>
          </tfoot>
        </table>
      </div>

      {cancelConfirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
          <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-2xl">
            <div className="space-y-2">
              <h2 className="text-lg font-semibold text-foreground">Cancel paid plan?</h2>
              <p className="text-sm text-muted-foreground">
                This will cancel the current paid plan and move the account back to Free. Your
                organization limits will follow the Free plan immediately.
              </p>
            </div>
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setCancelConfirmOpen(false)}
                disabled={loading === "cancel"}
                className="rounded-md border border-border px-4 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
              >
                Keep plan
              </button>
              <button
                type="button"
                onClick={handleCancelPlan}
                disabled={loading === "cancel"}
                className="rounded-md bg-red-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-600 disabled:opacity-50"
              >
                {loading === "cancel" ? "Canceling..." : "Confirm cancel"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
