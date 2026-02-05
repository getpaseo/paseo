import { createFileRoute, Link, Outlet } from '@tanstack/react-router'
import '~/styles.css'

export const Route = createFileRoute('/docs')({
  component: DocsLayout,
})

const navigation = [
  { name: 'Getting started', href: '/docs' },
  { name: 'Git worktrees', href: '/docs/worktrees' },
  { name: 'CLI', href: '/docs/cli' },
  { name: 'Configuration', href: '/docs/configuration' },
  { name: 'Security', href: '/docs/security' },
  { name: 'Best practices', href: '/docs/best-practices' },
]

function DocsLayout() {
  return (
    <div className="min-h-screen bg-background">
      {/* Mobile header */}
      <header className="md:hidden border-b border-border p-4">
        <Link to="/" className="flex items-center gap-3">
          <img src="/logo.svg" alt="Paseo" className="w-6 h-6" />
          <span className="text-lg font-medium">paseo</span>
        </Link>
        <nav className="flex gap-4 mt-4">
          {navigation.map((item) => (
            <Link
              key={item.href}
              to={item.href}
              activeOptions={{ exact: true }}
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
              activeProps={{ className: 'text-foreground' }}
            >
              {item.name}
            </Link>
          ))}
        </nav>
      </header>

      <div className="max-w-5xl mx-auto flex">
        {/* Desktop sidebar */}
        <aside className="hidden md:block w-56 shrink-0 border-r border-border p-6 sticky top-0 h-screen">
          <Link to="/" className="flex items-center gap-3 mb-8">
            <img src="/logo.svg" alt="Paseo" className="w-6 h-6" />
            <span className="text-lg font-medium">paseo</span>
          </Link>
          <nav className="space-y-1">
            {navigation.map((item) => (
              <Link
                key={item.href}
                to={item.href}
                activeOptions={{ exact: true }}
                className="block px-3 py-2 text-sm rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                activeProps={{ className: 'bg-muted text-foreground' }}
              >
                {item.name}
              </Link>
            ))}
          </nav>
        </aside>
        <main className="flex-1 p-6 md:p-12 max-w-3xl">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
