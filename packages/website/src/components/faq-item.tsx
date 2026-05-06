import type { ReactNode } from "react";

export function FAQItem({ question, children }: { question: string; children: ReactNode }) {
  return (
    <details className="group">
      <summary className="font-medium text-sm cursor-pointer list-none flex items-start gap-2 -ml-4">
        <span className="font-mono text-white/40 flex-shrink-0 group-open:hidden">+</span>
        <span className="font-mono text-white/40 flex-shrink-0 hidden group-open:inline">−</span>
        {question}
      </summary>
      <div className="text-sm text-muted-foreground space-y-2 mt-2 prose">{children}</div>
    </details>
  );
}
