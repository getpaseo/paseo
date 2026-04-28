import { createFileRoute } from "@tanstack/react-router";
import { pageMeta } from "~/meta";
import { SiteHeader } from "~/components/site-header";
import { PlansGrid } from "~/components/plans";
import { BookDemoCTA } from "~/components/book-demo-cta";
import "~/styles.css";

export const Route = createFileRoute("/pricing")({
  head: () => ({
    meta: pageMeta(
      "Pricing — Hubcode",
      "Free, Pro and Enterprise plans for Hubcode. Bring your own keys for free, or unlock the Hubtool curated agent, org chat, audit log, SSO and more.",
    ),
  }),
  component: Pricing,
});

function Pricing() {
  return (
    <div className="min-h-screen bg-background relative overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 left-1/2 -translate-x-1/2 h-[640px] w-[1100px] rounded-full opacity-40 blur-[140px]"
        style={{
          background: "radial-gradient(closest-side, rgba(216,27,96,0.55), rgba(216,27,96,0) 70%)",
        }}
      />
      <div className="relative max-w-6xl mx-auto p-6 md:p-12">
        <div className="mb-12">
          <SiteHeader />
        </div>

        <div className="text-center max-w-2xl mx-auto mb-14 space-y-3">
          <span className="inline-block h-[2px] w-10 rounded-full bg-gradient-to-r from-[#D81B60] to-[#FF4081]" />
          <h1 className="text-3xl md:text-5xl font-medium tracking-tight">Pricing</h1>
          <p className="text-base text-white/60">
            The Hubcode app, daemon and CLI are free with your own provider keys. Pro and Enterprise
            unlock the curated <strong className="text-white/90">Hubtool agent</strong>,
            organization chat, audit log, SSO and team-scale capacity.
          </p>
        </div>

        <PlansGrid />

        <div className="mt-12">
          <BookDemoCTA />
        </div>

        <div className="mt-12 grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-5">
            <p className="text-white/90 font-medium mb-1">Self-hosted by default</p>
            <p className="text-white/50">
              Every plan runs on top of your own daemon — your code never routes through Hubcode.
            </p>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-5">
            <p className="text-white/90 font-medium mb-1">Cancel anytime</p>
            <p className="text-white/50">
              Yearly saves about 17% per seat. Monthly is month-to-month — drop back to Free
              whenever you want.
            </p>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-5">
            <p className="text-white/90 font-medium mb-1">Need something custom?</p>
            <p className="text-white/50">
              <a
                href="mailto:ceo@hubtool.ai"
                className="text-[#FF80AB] hover:text-[#FF4081] underline"
              >
                Get in touch
              </a>{" "}
              — happy to scope a tailored plan for your team.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
