import type { ReactNode } from "react";
import { PAGE_INSET_CLASS, PAGE_RAIL_CLASS, PageHeaderBand } from "~/components/page-frame";
import { SiteFooter } from "~/components/site-footer";
import { SiteHeader } from "~/components/site-header";

interface SiteShellProps {
  children: ReactNode;
  width: "default" | "prose" | "wide";
}

const MAIN_CLASSES: Record<Exclude<SiteShellProps["width"], "default">, string> = {
  prose: "max-w-prose p-6 md:p-12 mx-auto",
  wide: "max-w-7xl p-6 md:p-20 mx-auto",
};

export function SiteShell({ children, width }: SiteShellProps) {
  if (width === "default") {
    return (
      <div className="min-h-screen bg-background">
        <PageHeaderBand framed />
        <main className={`${PAGE_RAIL_CLASS} ${PAGE_INSET_CLASS} py-14 md:py-20`}>{children}</main>
        <SiteFooter width="default" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <main className={MAIN_CLASSES[width]}>
        <div className="mb-16">
          <SiteHeader />
        </div>
        {children}
      </main>
      <SiteFooter width={width} />
    </div>
  );
}
