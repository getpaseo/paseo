"use client";

import { useEffect, useMemo, useState } from "react";

interface Sub {
  id: string;
  userId: string;
  accountName: string;
  accountEmail: string;
  planId: string;
  planName: string;
  status: string;
  stripeSubscriptionId: string | null;
  createdAt: string;
}

function statusTone(status: string): string {
  if (status === "active") return "bg-emerald-500/10 text-emerald-300 border-emerald-500/20";
  if (status === "past_due") return "bg-amber-500/10 text-amber-300 border-amber-500/20";
  if (status === "canceled") return "bg-red-500/10 text-red-300 border-red-500/20";
  return "bg-muted/20 text-muted-foreground border-border/70";
}

export default function AdminSubscriptionsPage() {
  const [subs, setSubs] = useState<Sub[]>([]);
  const [statusFilter, setStatusFilter] = useState("");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  useEffect(() => {
    let cancelled = false;

    async function loadSubscriptions() {
      const params = new URLSearchParams({ page: String(page), limit: "20" });
      if (statusFilter) params.set("status", statusFilter);
      const res = await fetch(`/api/admin/subscriptions?${params}`);
      const data = await res.json();
      if (!cancelled) {
        setSubs(data.subscriptions);
        setTotalPages(data.pagination.pages);
      }
    }

    void loadSubscriptions();

    return () => {
      cancelled = true;
    };
  }, [statusFilter, page]);

  const summary = useMemo(() => {
    const active = subs.filter((sub) => sub.status === "active").length;
    const pastDue = subs.filter((sub) => sub.status === "past_due").length;
    const canceled = subs.filter((sub) => sub.status === "canceled").length;
    return { active, pastDue, canceled };
  }, [subs]);

  const reloadSubscriptions = async () => {
    const params = new URLSearchParams({ page: String(page), limit: "20" });
    if (statusFilter) params.set("status", statusFilter);
    const res = await fetch(`/api/admin/subscriptions?${params}`);
    const data = await res.json();
    setSubs(data.subscriptions);
    setTotalPages(data.pagination.pages);
  };

  const handleCancel = async (subId: string) => {
    const confirmed = window.confirm("Cancel this subscription?");
    if (!confirmed) return;

    await fetch(`/api/admin/subscriptions/${subId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "cancel" }),
    });

    await reloadSubscriptions();
  };

  return (
    <div className="space-y-8">
      <section className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-2">
          <div className="inline-flex items-center gap-2 rounded-full border border-primary/15 bg-primary/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-primary">
            <span className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-current text-[9px]">
              B
            </span>
            Billing Control
          </div>
          <div>
            <h1 className="text-4xl font-semibold tracking-tight text-foreground">Subscriptions</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Inspect paid accounts, track Stripe state and intervene quickly when billing changes.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3 rounded-2xl border border-border/70 bg-card/80 px-4 py-3">
          <span className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Filter</span>
          <select
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              setPage(1);
            }}
            className="bg-transparent text-sm text-foreground outline-none"
          >
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="canceled">Canceled</option>
            <option value="past_due">Past Due</option>
            <option value="trialing">Trialing</option>
          </select>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        <div className="rounded-[24px] border border-border/70 bg-card/80 p-5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Active
          </p>
          <p className="mt-2 text-3xl font-semibold text-foreground">{summary.active}</p>
        </div>
        <div className="rounded-[24px] border border-border/70 bg-card/80 p-5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Past Due
          </p>
          <p className="mt-2 text-3xl font-semibold text-foreground">{summary.pastDue}</p>
        </div>
        <div className="rounded-[24px] border border-border/70 bg-card/80 p-5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Canceled
          </p>
          <p className="mt-2 text-3xl font-semibold text-foreground">{summary.canceled}</p>
        </div>
      </section>

      <section className="overflow-hidden rounded-[28px] border border-border/70 bg-card/80 shadow-[0_24px_80px_rgba(0,0,0,0.2)]">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[880px] text-sm">
            <thead className="border-b border-border/70 bg-background/50">
              <tr>
                <th className="px-6 py-4 text-left text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  Account
                </th>
                <th className="px-6 py-4 text-left text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  Plan
                </th>
                <th className="px-6 py-4 text-left text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  Status
                </th>
                <th className="px-6 py-4 text-left text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  Stripe
                </th>
                <th className="px-6 py-4 text-right text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {subs.map((sub) => (
                <tr key={sub.id} className="transition-colors hover:bg-background/40">
                  <td className="px-6 py-5">
                    <div className="flex items-center gap-4">
                      <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10 text-sm font-semibold text-primary">
                        {sub.accountName?.charAt(0)?.toUpperCase() ?? "U"}
                      </div>
                      <div>
                        <p className="font-medium text-foreground">{sub.accountName}</p>
                        <p className="text-xs text-muted-foreground">{sub.accountEmail}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-5">
                    <span className="inline-flex rounded-full border border-primary/20 bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">
                      {sub.planName}
                    </span>
                  </td>
                  <td className="px-6 py-5">
                    <span
                      className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-medium capitalize ${statusTone(sub.status)}`}
                    >
                      {sub.status}
                    </span>
                  </td>
                  <td className="px-6 py-5">
                    <div className="inline-flex items-center gap-2 rounded-xl border border-border/70 bg-background/50 px-3 py-2 font-mono text-xs text-muted-foreground">
                      <span className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-border/70 text-[9px]">
                        S
                      </span>
                      {sub.stripeSubscriptionId
                        ? `${sub.stripeSubscriptionId.slice(0, 20)}...`
                        : "No Stripe subscription"}
                    </div>
                  </td>
                  <td className="px-6 py-5 text-right">
                    {sub.status === "active" && sub.stripeSubscriptionId ? (
                      <button
                        onClick={() => handleCancel(sub.id)}
                        className="rounded-xl border border-red-500/25 px-3 py-2 text-xs font-medium text-red-300 transition-colors hover:bg-red-500/10"
                      >
                        Cancel
                      </button>
                    ) : (
                      <span className="text-xs text-muted-foreground">No action</span>
                    )}
                  </td>
                </tr>
              ))}
              {subs.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-6 py-14 text-center text-sm text-muted-foreground">
                    No subscriptions found for the selected filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3">
          <button
            onClick={() => setPage((current) => Math.max(1, current - 1))}
            disabled={page === 1}
            className="rounded-xl border border-border/70 px-4 py-2 text-sm text-foreground disabled:opacity-50"
          >
            Previous
          </button>
          <span className="text-sm text-muted-foreground">
            Page {page} of {totalPages}
          </span>
          <button
            onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
            disabled={page === totalPages}
            className="rounded-xl border border-border/70 px-4 py-2 text-sm text-foreground disabled:opacity-50"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
