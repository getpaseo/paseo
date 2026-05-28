import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { Menu, X } from "lucide-react";
import { useCallback, useState } from "react";
import { type Doc, getDocs } from "~/docs";
import "~/styles.css";

export const Route = createFileRoute("/docs")({
  component: DocsLayout,
});

const ACTIVE_OPTIONS_EXACT = { exact: true };
const MOBILE_ACTIVE_PROPS = { className: "text-foreground" };
const DESKTOP_ACTIVE_PROPS = { className: "bg-muted text-foreground" };

interface NavItem {
  name: string;
  href: string;
}

interface NavGroup {
  name: string | null;
  items: NavItem[];
}

const GROUP_LABELS: Record<string, string> = {
  alternatives: "Alternatives",
};

function groupKey(doc: Doc): string | null {
  const idx = doc.slug.indexOf("/");
  return idx === -1 ? null : doc.slug.slice(0, idx);
}

function buildNavigation(): NavGroup[] {
  const groups = new Map<string | null, NavItem[]>();
  for (const doc of getDocs()) {
    const key = groupKey(doc);
    const items = groups.get(key) ?? [];
    items.push({ name: doc.frontmatter.nav, href: doc.href });
    groups.set(key, items);
  }
  const ordered: NavGroup[] = [];
  if (groups.has(null)) ordered.push({ name: null, items: groups.get(null)! });
  for (const [key, items] of groups) {
    if (key === null) continue;
    ordered.push({ name: GROUP_LABELS[key] ?? key, items });
  }
  return ordered;
}

function DocsLayout() {
  const groups = buildNavigation();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const toggleMobileNav = useCallback(() => setMobileNavOpen((v) => !v), []);
  const closeMobileNav = useCallback(() => setMobileNavOpen(false), []);

  return (
    <div className="min-h-screen bg-background">
      {/* Mobile header */}
      <header className="md:hidden sticky top-0 z-50 bg-background border-b border-border">
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
          <nav className="border-t border-border px-4 py-4 space-y-4 max-h-[calc(100dvh-4rem)] overflow-y-auto">
            {groups.map((group) => (
              <div key={group.name ?? "root"} className="space-y-1">
                {group.name && (
                  <div className="text-sm font-medium text-foreground mb-2">{group.name}</div>
                )}
                {group.items.map((item) => (
                  <Link
                    key={item.href}
                    to={item.href}
                    activeOptions={ACTIVE_OPTIONS_EXACT}
                    onClick={closeMobileNav}
                    className="block py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
                    activeProps={MOBILE_ACTIVE_PROPS}
                  >
                    {item.name}
                  </Link>
                ))}
              </div>
            ))}
          </nav>
        )}
      </header>

      <div className="flex">
        {/* Desktop sidebar */}
        <aside className="hidden md:flex md:flex-col w-56 shrink-0 border-r border-border p-6 sticky top-0 h-screen">
          <Link to="/" className="flex items-center gap-3 mb-8 shrink-0">
            <img src="/logo.svg" alt="Paseo" className="w-6 h-6" />
            <span className="text-lg font-medium">Paseo</span>
          </Link>
          <nav className="flex-1 min-h-0 overflow-y-auto -ml-3 -mr-3 pr-3 space-y-4">
            {groups.map((group) => (
              <div key={group.name ?? "root"} className="space-y-1">
                {group.name && (
                  <div className="px-3 py-2 text-sm font-medium text-foreground">{group.name}</div>
                )}
                {group.items.map((item) => (
                  <Link
                    key={item.href}
                    to={item.href}
                    activeOptions={ACTIVE_OPTIONS_EXACT}
                    className="block px-3 py-2 text-sm rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                    activeProps={DESKTOP_ACTIVE_PROPS}
                  >
                    {item.name}
                  </Link>
                ))}
              </div>
            ))}
          </nav>
        </aside>
        <main className="flex-1 min-w-0 p-6 md:p-12 max-w-3xl docs-prose">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
