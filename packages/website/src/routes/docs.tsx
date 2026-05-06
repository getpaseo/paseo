import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { getDocs } from "~/docs";
import "~/styles.css";

export const Route = createFileRoute("/docs")({
  component: DocsLayout,
});

const ACTIVE_OPTIONS_EXACT = { exact: true };
const MOBILE_ACTIVE_PROPS = { className: "text-foreground" };
const DESKTOP_ACTIVE_PROPS = { className: "bg-muted text-foreground" };

function DocsLayout() {
  const navigation = getDocs().map((doc) => ({
    name: doc.frontmatter.nav,
    href: doc.href,
  }));

  return (
    <div className="min-h-screen bg-background">
      {/* Mobile header */}
      <header className="md:hidden border-b border-border p-4">
        <Link to="/" className="flex items-center gap-3">
          <img src="/logo.svg" alt="Paseo" className="w-6 h-6" />
          <span className="text-lg font-medium">Paseo</span>
        </Link>
        <nav className="flex gap-4 mt-4 flex-wrap">
          {navigation.map((item) => (
            <Link
              key={item.href}
              to={item.href}
              activeOptions={ACTIVE_OPTIONS_EXACT}
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
              activeProps={MOBILE_ACTIVE_PROPS}
            >
              {item.name}
            </Link>
          ))}
        </nav>
      </header>

      <div className="flex">
        {/* Desktop sidebar */}
        <aside className="hidden md:block w-56 shrink-0 border-r border-border p-6 sticky top-0 h-screen">
          <Link to="/" className="flex items-center gap-3 mb-8">
            <img src="/logo.svg" alt="Paseo" className="w-6 h-6" />
            <span className="text-lg font-medium">Paseo</span>
          </Link>
          <nav className="space-y-1 -ml-3">
            {navigation.map((item) => (
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
          </nav>
        </aside>
        <main className="flex-1 p-6 md:p-12 max-w-3xl docs-prose">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
