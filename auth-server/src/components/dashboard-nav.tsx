"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/utils";

interface DashboardNavProps {
  user: {
    id: string;
    name: string;
    email: string;
    image?: string | null;
  };
}

export function DashboardNav({ user }: DashboardNavProps) {
  const pathname = usePathname();

  const handleSignOut = async () => {
    await authClient.signOut();
    window.location.href = "/sign-in/web";
  };

  const navItems = [
    { href: "/dashboard", label: "Overview" },
    { href: "/dashboard/billing", label: "Billing" },
    { href: "/dashboard/organizations", label: "Organizations" },
    { href: "/dashboard/settings", label: "Settings" },
  ];

  return (
    <header className="border-b border-border/60 bg-card/50 backdrop-blur-sm sticky top-0 z-50">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-6 h-14">
        <div className="flex items-center gap-8">
          <Link href="/dashboard" className="flex items-center gap-2">
            <img src="/logo-icon-hubcode.png" alt="Hubcode" className="h-6 w-6 rounded-md" />
            <span className="text-sm font-semibold text-foreground">Hubcode</span>
          </Link>
          <nav className="flex items-center gap-1">
            {navItems.map((item) => {
              const isActive = pathname === item.href || pathname.startsWith(item.href + "/");
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "px-3 py-1.5 text-[13px] font-medium rounded-md transition-colors",
                    isActive
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-accent/50",
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
            {(user as { role?: string }).role === "admin" && (
              <Link
                href="/admin"
                className={cn(
                  "px-3 py-1.5 text-[13px] font-medium rounded-md transition-colors",
                  pathname.startsWith("/admin")
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent/50",
                )}
              >
                Admin
              </Link>
            )}
          </nav>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2.5">
            {user.image ? (
              <img
                src={user.image}
                alt={user.name}
                className="h-6 w-6 rounded-full ring-1 ring-border"
              />
            ) : (
              <div className="h-6 w-6 rounded-full bg-secondary flex items-center justify-center">
                <span className="text-[10px] font-medium text-muted-foreground">
                  {user.name?.charAt(0)?.toUpperCase()}
                </span>
              </div>
            )}
            <span className="text-[13px] text-muted-foreground">{user.name}</span>
          </div>
          <div className="h-4 w-px bg-border/60" />
          <button
            onClick={handleSignOut}
            className="text-[13px] text-muted-foreground transition-colors hover:text-foreground"
          >
            Sign Out
          </button>
        </div>
      </div>
    </header>
  );
}
