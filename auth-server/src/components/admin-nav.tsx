"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

interface AdminNavProps {
  user: { id: string; name: string; email: string; image?: string | null };
}

export function AdminNav({ user }: AdminNavProps) {
  const pathname = usePathname();

  const navItems = [
    { href: "/admin", label: "Dashboard", exact: true },
    { href: "/admin/users", label: "Users" },
    { href: "/admin/organizations", label: "Organizations" },
    { href: "/admin/plans", label: "Plans" },
    { href: "/admin/subscriptions", label: "Subscriptions" },
    { href: "/admin/activity", label: "Activity" },
  ];

  return (
    <header className="sticky top-0 z-50 border-b border-border/60 bg-background/90 backdrop-blur-xl">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-4 sm:px-6 lg:px-8">
        <div className="flex min-w-0 items-center gap-6">
          <Link href="/admin" className="flex items-center gap-3">
            <div className="relative">
              <div className="absolute inset-0 rounded-2xl bg-primary/20 blur-md" />
              <div className="relative flex h-10 w-10 items-center justify-center rounded-2xl border border-primary/20 bg-card">
                <img src="/logo-icon-hubcode.png" alt="Hubcode" className="h-6 w-6 rounded-md" />
              </div>
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-base font-semibold text-foreground">Hubcode</span>
                <span className="inline-flex items-center gap-1 rounded-full border border-red-500/25 bg-red-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-red-300">
                  <span className="inline-flex h-3 w-3 items-center justify-center rounded-full border border-current text-[8px]">
                    S
                  </span>
                  Admin
                </span>
              </div>
              <p className="text-[11px] text-muted-foreground">Control plane for your workspace</p>
            </div>
          </Link>

          <nav className="hidden items-center gap-1 rounded-2xl border border-border/70 bg-card/70 p-1.5 lg:flex">
            {navItems.map((item) => {
              const isActive = item.exact ? pathname === item.href : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "rounded-xl px-3 py-2 text-[13px] font-medium transition-colors",
                    isActive
                      ? "bg-primary/15 text-foreground shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)]"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>

        <div className="flex items-center gap-3">
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-2 rounded-xl border border-border/70 bg-card/70 px-3 py-2 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <span aria-hidden>&larr;</span>
            Back to Dashboard
          </Link>
          <div className="hidden h-6 w-px bg-border/60 sm:block" />
          <div className="hidden items-center gap-3 rounded-2xl border border-border/70 bg-card/70 px-3 py-2 sm:flex">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 text-sm font-semibold text-primary">
              {user.name?.charAt(0)?.toUpperCase()}
            </div>
            <div className="min-w-0">
              <p className="truncate text-[13px] font-medium text-foreground">{user.name}</p>
              <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <span aria-hidden>+</span>
                Elevated access
              </p>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
