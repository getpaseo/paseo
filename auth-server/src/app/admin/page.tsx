"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

interface Stats {
  totalUsers: number;
  totalOrganizations: number;
  activeSubscriptions: number;
  mrr: number;
  canceledSubscriptions: number;
}

export default function AdminDashboard() {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadStats() {
      const res = await fetch("/api/admin/stats");
      const data = await res.json();
      if (!cancelled) {
        setStats(data);
      }
    }

    void loadStats();

    return () => {
      cancelled = true;
    };
  }, []);

  if (!stats) {
    return <p className="text-sm text-muted-foreground">Loading admin workspace...</p>;
  }

  const kpis = [
    {
      label: "Users",
      value: stats.totalUsers,
      icon: "U",
      tone: "bg-blue-500/10 text-blue-300",
      caption: "Accounts with access to Hubcode",
    },
    {
      label: "Organizations",
      value: stats.totalOrganizations,
      icon: "O",
      tone: "bg-fuchsia-500/10 text-fuchsia-300",
      caption: "Teams currently created",
    },
    {
      label: "Active Subscriptions",
      value: stats.activeSubscriptions,
      icon: "S",
      tone: "bg-emerald-500/10 text-emerald-300",
      caption: "Accounts on a paid plan",
    },
    {
      label: "MRR",
      value: `$${stats.mrr.toFixed(2)}`,
      icon: "$",
      tone: "bg-amber-500/10 text-amber-300",
      caption: "Monthly recurring revenue",
    },
    {
      label: "Canceled",
      value: stats.canceledSubscriptions,
      icon: "C",
      tone: "bg-red-500/10 text-red-300",
      caption: "Subscriptions no longer active",
    },
  ];

  const quickLinks = [
    {
      href: "/admin/users",
      title: "Review users",
      description: "Promote admins, inspect accounts and manage access.",
    },
    {
      href: "/admin/subscriptions",
      title: "Inspect billing",
      description: "Track paid accounts, cancellations and Stripe state.",
    },
    {
      href: "/admin/activity",
      title: "Audit activity",
      description: "Follow actions across accounts, plans and organizations.",
    },
  ];

  return (
    <div className="space-y-8">
      <section className="rounded-[28px] border border-border/70 bg-card/80 p-6 shadow-[0_24px_80px_rgba(0,0,0,0.22)]">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-2xl space-y-3">
            <div className="inline-flex items-center gap-2 rounded-full border border-primary/15 bg-primary/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-primary">
              <span className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-current text-[9px]">
                A
              </span>
              Admin Control Center
            </div>
            <div>
              <h1 className="text-4xl font-semibold tracking-tight text-foreground">
                Hubcode Operations
              </h1>
              <p className="mt-2 text-sm text-muted-foreground">
                Monitor growth, billing and account health from a single control plane built for
                fast interventions.
              </p>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3 lg:min-w-[25rem]">
            <div className="rounded-2xl border border-border/70 bg-background/70 p-4">
              <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">MRR</p>
              <p className="mt-2 text-2xl font-semibold text-foreground">${stats.mrr.toFixed(2)}</p>
            </div>
            <div className="rounded-2xl border border-border/70 bg-background/70 p-4">
              <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                Paid Accounts
              </p>
              <p className="mt-2 text-2xl font-semibold text-foreground">
                {stats.activeSubscriptions}
              </p>
            </div>
            <div className="rounded-2xl border border-border/70 bg-background/70 p-4">
              <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Teams</p>
              <p className="mt-2 text-2xl font-semibold text-foreground">
                {stats.totalOrganizations}
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {kpis.map((kpi) => {
          return (
            <div
              key={kpi.label}
              className="rounded-[24px] border border-border/70 bg-card/80 p-5 shadow-[0_18px_60px_rgba(0,0,0,0.18)]"
            >
              <div
                className={`inline-flex h-11 w-11 items-center justify-center rounded-2xl ${kpi.tone}`}
              >
                <span className="text-sm font-semibold">{kpi.icon}</span>
              </div>
              <p className="mt-5 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                {kpi.label}
              </p>
              <p className="mt-2 text-3xl font-semibold text-foreground">{kpi.value}</p>
              <p className="mt-2 text-xs text-muted-foreground">{kpi.caption}</p>
            </div>
          );
        })}
      </section>

      <section className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <div className="rounded-[24px] border border-border/70 bg-card/80 p-6">
          <h2 className="text-lg font-semibold text-foreground">Operational Snapshot</h2>
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <div className="rounded-2xl border border-border/70 bg-background/70 p-5">
              <p className="text-sm font-medium text-foreground">Revenue quality</p>
              <p className="mt-2 text-sm text-muted-foreground">
                {stats.activeSubscriptions} active subscriptions versus{" "}
                {stats.canceledSubscriptions} canceled subscriptions.
              </p>
            </div>
            <div className="rounded-2xl border border-border/70 bg-background/70 p-5">
              <p className="text-sm font-medium text-foreground">Adoption</p>
              <p className="mt-2 text-sm text-muted-foreground">
                {stats.totalOrganizations} organizations are spread across {stats.totalUsers} user
                accounts.
              </p>
            </div>
          </div>
        </div>

        <div className="rounded-[24px] border border-border/70 bg-card/80 p-6">
          <h2 className="text-lg font-semibold text-foreground">Quick Actions</h2>
          <div className="mt-5 space-y-3">
            {quickLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="group flex items-center justify-between rounded-2xl border border-border/70 bg-background/70 p-4 transition-colors hover:bg-accent/50"
              >
                <div className="pr-4">
                  <p className="text-sm font-medium text-foreground">{link.title}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{link.description}</p>
                </div>
                <span className="text-sm text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground">
                  &rarr;
                </span>
              </Link>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
