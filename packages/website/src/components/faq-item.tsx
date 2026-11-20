import type { ReactNode } from "react";

export function FAQItem({ question, children }: { question: string; children: ReactNode }) {
  return (
    <details className="group">
      <summary className="font-medium text-sm cursor-pointer list-none grid grid-cols-[1.25rem_1fr] items-baseline">
        <span className="font-mono text-lg leading-none text-white/40 group-open:hidden">+</span>
        <span className="font-mono text-lg leading-none text-white/40 hidden group-open:inline">
          −
        </span>
        {question}
      </summary>
      <div className="text-sm text-muted-foreground space-y-2 mt-2 pl-5 prose">{children}</div>
    </details>
  );
}
