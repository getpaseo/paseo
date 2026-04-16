"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface PlanFeature {
  id: string;
  featureKey: string;
  value: string;
  description: string | null;
}

interface Plan {
  id: string;
  name: string;
  slug: string;
  stripePriceId: string | null;
  monthlyPriceCents: number;
  active: boolean;
  features: PlanFeature[];
}

export default function AdminPlansPage() {
  const [plans, setPlans] = useState<Plan[]>([]);

  const fetchPlans = async () => {
    const res = await fetch("/api/admin/plans");
    const data = await res.json();
    setPlans(data.plans);
  };

  useEffect(() => {
    fetchPlans();
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-foreground">Plans</h1>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {plans.map((p) => (
          <div key={p.id} className="rounded-lg border border-border bg-card p-6">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-foreground">{p.name}</h3>
              {!p.active && (
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                  Inactive
                </span>
              )}
            </div>
            <p className="mt-1 text-2xl font-bold text-foreground">
              {p.monthlyPriceCents === 0 ? "Free" : `$${(p.monthlyPriceCents / 100).toFixed(0)}/mo`}
            </p>
            {(p as Record<string, unknown>).yearlyPriceCents !== undefined &&
              (p as Record<string, unknown>).yearlyPriceCents !== 0 && (
                <p className="text-sm text-muted-foreground">
                  ${(((p as Record<string, unknown>).yearlyPriceCents as number) / 100).toFixed(0)}
                  /yr
                </p>
              )}
            <p className="mt-1 text-xs text-muted-foreground">Slug: {p.slug}</p>

            <div className="mt-4 space-y-1.5">
              <p className="text-xs font-medium uppercase text-muted-foreground">Feature Flags</p>
              {p.features.map((f) => (
                <div
                  key={f.id}
                  className="flex items-center justify-between rounded bg-muted/50 px-2 py-1 text-xs"
                >
                  <span className="text-foreground">{f.featureKey}</span>
                  <span className="font-mono text-muted-foreground">{f.value}</span>
                </div>
              ))}
            </div>

            <Link
              href={`/admin/plans/${p.id}/features`}
              className="mt-4 block w-full rounded-md border border-border px-3 py-1.5 text-center text-sm font-medium text-foreground transition-colors hover:bg-accent"
            >
              Edit Features
            </Link>
          </div>
        ))}
      </div>
    </div>
  );
}
