import * as React from "react";

export interface Plan {
  name: string;
  price: string;
  cadence?: string;
  saving?: string;
  blurb: string;
  cta: { label: string; href: string };
  highlight?: boolean;
  features: { label: string; value?: string; included: boolean }[];
}

export const plans: Plan[] = [
  {
    name: "Free",
    price: "$0",
    blurb: "The full Hubcode app, daemon and CLI with your own provider keys.",
    cta: { label: "Get started", href: "/download" },
    features: [
      { label: "Hubcode curated combos", included: false },
      { label: "Org chat & messaging", included: false },
      { label: "Audit log", included: false },
      { label: "SSO / SAML", included: false },
      { label: "Organizations", value: "Up to 1", included: true },
      { label: "Members per organization", value: "Up to 2", included: true },
      { label: "Concurrent shared workspaces", value: "Up to 1", included: true },
      { label: "Agent session duration (min)", value: "Up to 60", included: true },
      { label: "Active skills", value: "Up to 10", included: true },
      { label: "Active MCP servers", value: "Up to 10", included: true },
      { label: "Issue-tracker integrations", value: "Up to 1", included: true },
      { label: "Support tier", value: "community", included: true },
    ],
  },
  {
    name: "Pro",
    price: "$20",
    cadence: "/mo",
    saving: "or save ~17% with yearly",
    blurb: "Everything in Free, plus the curated Hubtool agent and org messaging.",
    cta: { label: "Upgrade to Pro", href: "/download" },
    highlight: true,
    features: [
      { label: "Hubcode curated combos", included: true },
      { label: "Org chat & messaging", included: true },
      { label: "Audit log", included: false },
      { label: "SSO / SAML", included: false },
      { label: "Organizations", value: "Up to 1", included: true },
      { label: "Members per organization", value: "Up to 4", included: true },
      { label: "Concurrent shared workspaces", value: "Up to 2", included: true },
      { label: "Agent session duration (min)", value: "Unlimited", included: true },
      { label: "Active skills", value: "Unlimited", included: true },
      { label: "Active MCP servers", value: "Unlimited", included: true },
      { label: "Issue-tracker integrations", value: "Unlimited", included: true },
      { label: "Attachments storage (GB)", value: "Up to 50", included: true },
      { label: "Message retention (days)", value: "Up to 365", included: true },
      { label: "Support tier", value: "standard 24h", included: true },
    ],
  },
  {
    name: "Enterprise",
    price: "$250",
    cadence: "/mo",
    saving: "or save ~17% with yearly",
    blurb: "Everything in Pro, plus audit log, SSO/SAML and team-wide capacity.",
    cta: { label: "Book a demo", href: "https://cal.com/hubcode/demo" },
    features: [
      { label: "Hubcode curated combos", included: true },
      { label: "Org chat & messaging", included: true },
      { label: "Audit log", included: true },
      { label: "SSO / SAML", included: true },
      { label: "Organizations", value: "Up to 3", included: true },
      { label: "Members per organization", value: "Up to 20", included: true },
      { label: "Concurrent shared workspaces", value: "Up to 20", included: true },
      { label: "Agent session duration (min)", value: "Unlimited", included: true },
      { label: "Active skills", value: "Unlimited", included: true },
      { label: "Active MCP servers", value: "Unlimited", included: true },
      { label: "Issue-tracker integrations", value: "Unlimited", included: true },
      { label: "Attachments storage (GB)", value: "Up to 200", included: true },
      { label: "Message retention (days)", value: "Unlimited", included: true },
      { label: "Support tier", value: "premium 4h", included: true },
    ],
  },
];

export function PlansGrid({ compact = false }: { compact?: boolean }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
      {plans.map((plan) => (
        <PlanCard key={plan.name} plan={plan} compact={compact} />
      ))}
    </div>
  );
}

export function PlanCard({ plan, compact = false }: { plan: Plan; compact?: boolean }) {
  const cardClass = plan.highlight
    ? "rounded-2xl border border-[#D81B60]/50 bg-gradient-to-br from-[#D81B60]/[0.12] via-white/[0.02] to-transparent p-6 md:p-7 shadow-[0_0_60px_-20px_rgba(216,27,96,0.6)] relative"
    : "rounded-2xl border border-white/10 bg-white/[0.02] p-6 md:p-7 relative";

  return (
    <div className={cardClass}>
      {plan.highlight ? (
        <span className="absolute -top-3 left-6 rounded-full bg-gradient-to-r from-[#D81B60] to-[#FF4081] px-3 py-1 text-[10px] font-semibold tracking-wide text-white uppercase">
          Most popular
        </span>
      ) : null}

      <div className="space-y-1.5">
        <p className="text-sm font-medium text-white/80">{plan.name}</p>
        <div className="flex items-baseline gap-1.5">
          <span className="text-4xl font-medium text-white">{plan.price}</span>
          {plan.cadence ? <span className="text-white/50 text-sm">{plan.cadence}</span> : null}
        </div>
        {plan.saving ? <p className="text-xs text-white/40">{plan.saving}</p> : null}
        <p className="text-sm text-white/60 pt-2">{plan.blurb}</p>
      </div>

      <a
        href={plan.cta.href}
        {...(plan.cta.href.startsWith("http")
          ? { target: "_blank", rel: "noopener noreferrer" }
          : {})}
        className={
          plan.highlight
            ? "mt-5 block text-center rounded-lg bg-gradient-to-r from-[#D81B60] to-[#FF4081] px-4 py-2.5 text-sm font-medium text-white shadow-[0_0_24px_-6px_rgba(216,27,96,0.7)] hover:from-[#E91E63] hover:to-[#FF6090] transition-all"
            : "mt-5 block text-center rounded-lg border border-white/15 px-4 py-2.5 text-sm font-medium text-white hover:bg-white/5 transition-colors"
        }
      >
        {plan.cta.label}
      </a>

      <ul
        className={`mt-6 space-y-2 text-sm ${compact ? "max-h-[260px] overflow-hidden mask-fade-bottom" : ""}`}
      >
        {(compact ? plan.features.slice(0, 8) : plan.features).map((f) => (
          <li
            key={f.label}
            className={`flex items-start gap-2 ${f.included ? "text-white/85" : "text-white/30"}`}
          >
            {f.included ? (
              <span className="text-[#FF4081] mt-0.5">✓</span>
            ) : (
              <span className="text-white/30 mt-0.5">×</span>
            )}
            <span>
              <span className={f.included ? "" : "line-through"}>{f.label}</span>
              {f.value ? <span className="text-white/40 font-normal"> · {f.value}</span> : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
