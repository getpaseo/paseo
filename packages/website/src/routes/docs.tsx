import { createFileRoute, Link, Outlet, useLocation } from "@tanstack/react-router";
import { Menu, X } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { DocsBreadcrumbs } from "~/components/docs-breadcrumbs";
import { DocsNav } from "~/components/docs-nav";
import { DocsOutline } from "~/components/docs-outline";
import { buildDocsNavTree, getDoc, getDocs } from "~/docs";
import "~/styles.css";

export const Route = createFileRoute("/docs")({
  component: DocsLayout,
});

function DocsLayout() {
  const location = useLocation();
  const tree = useMemo(() => buildDocsNavTree(getDocs()), []);

  const slug = location.pathname === "/docs" ? "" : location.pathname.slice("/docs/".length);
  const doc = getDoc(slug);

  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const toggleMobileNav = useCallback(() => setMobileNavOpen((v) => !v), []);
  const closeMobileNav = useCallback(() => setMobileNavOpen(false), []);

  return (
    <div className="min-h-screen bg-background">
      {/* Mobile header */}
      <header className="lg:hidden sticky top-0 z-50 bg-background border-b border-border">
        <div className="flex items-center justify-between p-4">
          <Link to="/" className="flex items-center gap-3">
            <img src="/logo.svg" alt="Paseo" className="w-6 h-6" />
            <span className="text-lg font-medium">Paseo</span>
          </Link>
          <button
            type="button"
            onClick={toggleMobileNav}
            aria-label={mobileNavOpen ? "Close menu" : "Open menu"}
            aria-expanded={mobileNavOpen}
            className="-mr-2 p-2 text-muted-foreground hover:text-foreground transition-colors"
          >
            {mobileNavOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>
        {mobileNavOpen && (
          <nav className="border-t border-border px-4 py-4 max-h-[calc(100dvh-4rem)] overflow-y-auto">
            <DocsNav nodes={tree} mobile onNavigate={closeMobileNav} />
          </nav>
        )}
      </header>

      <div className="max-w-[90rem] mx-auto flex items-start">
        {/* Desktop sidebar */}
        <aside className="hidden lg:block sticky top-0 h-screen w-60 shrink-0 border-r border-border p-6 overflow-y-auto">
          <Link to="/" className="flex items-center gap-3 mb-8">
            <img src="/logo.svg" alt="Paseo" className="w-6 h-6" />
            <span className="text-lg font-medium">Paseo</span>
          </Link>
          <DocsNav nodes={tree} />
        </aside>

        {/* Main content */}
        <main className="flex-1 min-w-0 px-6 md:px-12 py-8 md:py-12">
          <div className="max-w-prose mx-auto">
            {doc && <DocsBreadcrumbs doc={doc} tree={tree} />}
            <Outlet />
          </div>
        </main>

        {/* Right outline */}
        <aside className="hidden xl:block sticky top-0 h-screen w-60 shrink-0 px-2 overflow-y-auto">
          {doc && <DocsOutline headings={doc.headings} />}
        </aside>
      </div>
    </div>
  );
}
