import type { ReactNode } from "react";

export function FAQItem({ question, children }: { question: string; children: ReactNode }) {
  return (
    <details className="group py-5 first:pt-4 last:pb-4">
      <summary className="flex cursor-pointer list-none items-baseline justify-between gap-6 text-[15px] font-medium text-white/90 transition-colors hover:text-white">
        <span>{question}</span>
        <span
          aria-hidden="true"
          className="shrink-0 font-mono text-base leading-none text-white/40 transition-colors group-hover:text-white/70 group-open:hidden"
        >
          +
        </span>
        <span
          aria-hidden="true"
          className="hidden shrink-0 font-mono text-base leading-none text-accent-text group-open:inline"
        >
          −
        </span>
      </summary>
      <div className="prose mt-3 max-w-2xl space-y-2.5 text-sm leading-relaxed text-muted-foreground">
        {children}
      </div>
    </details>
  );
}
