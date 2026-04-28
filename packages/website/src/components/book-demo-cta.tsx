import { demoUrl } from "~/downloads";

export function BookDemoCTA({ variant = "full" }: { variant?: "full" | "compact" }) {
  if (variant === "compact") {
    return (
      <a
        href={demoUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-2 rounded-lg border border-[#D81B60]/40 bg-[#D81B60]/10 px-4 py-2 text-sm font-medium text-white hover:bg-[#D81B60]/20 transition-colors"
      >
        <CalendarIcon className="w-4 h-4" />
        Book a demo
      </a>
    );
  }

  return (
    <div className="relative overflow-hidden rounded-2xl border border-[#D81B60]/30 bg-gradient-to-br from-[#D81B60]/[0.10] via-white/[0.02] to-transparent p-8 md:p-10 shadow-[0_30px_80px_-30px_rgba(216,27,96,0.5)]">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-24 -right-16 h-72 w-72 rounded-full opacity-40 blur-3xl"
        style={{ background: "rgba(216,27,96,0.55)" }}
      />
      <div className="relative grid grid-cols-1 md:grid-cols-[1fr_auto] gap-6 items-center">
        <div className="space-y-2">
          <span className="inline-flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.2em] text-[#FF80AB]">
            <span className="block h-[2px] w-8 rounded-full bg-gradient-to-r from-[#D81B60] to-[#FF4081]" />
            Talk to us
          </span>
          <h3 className="text-2xl md:text-3xl font-medium tracking-tight text-white">
            See Hubcode in action
          </h3>
          <p className="text-sm md:text-base text-white/65 max-w-lg">
            Want a guided tour? Book a 30-minute call and we'll walk through the kanban, shared
            sessions, the Hubtool agent and how teams roll Hubcode out across their org.
          </p>
        </div>
        <div className="flex flex-col items-start md:items-end gap-2">
          <a
            href={demoUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-[#D81B60] to-[#FF4081] px-5 py-2.5 text-sm font-medium text-white shadow-[0_0_24px_-6px_rgba(216,27,96,0.7)] hover:from-[#E91E63] hover:to-[#FF6090] transition-all"
          >
            <CalendarIcon className="w-4 h-4" />
            Schedule a call
          </a>
          <span className="text-xs text-white/40">30 min · no commitment</span>
        </div>
      </div>
    </div>
  );
}

function CalendarIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  );
}
