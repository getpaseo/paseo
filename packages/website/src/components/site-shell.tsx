import type { ReactNode } from "react";
import { SiteFooter } from "~/components/site-footer";
import { SiteHeader } from "~/components/site-header";

interface SiteShellProps {
  children: ReactNode;
  width?: "default" | "prose";
}

export function SiteShell({ children, width = "default" }: SiteShellProps) {
  const mainClasses =
    width === "prose" ? "max-w-prose p-6 md:p-12 mx-auto" : "max-w-5xl p-6 md:p-20 mx-auto";
  return (
    <div className="min-h-screen bg-background">
      <main className={mainClasses}>
        <div className="mb-12">
          <SiteHeader />
        </div>
        {children}
      </main>
      <SiteFooter width={width} />
    </div>
  );
}
