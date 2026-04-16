import { getServerSession } from "@/lib/session";
import { db } from "@/lib/db";
import { member, organization } from "@/db/schema";
import { eq } from "drizzle-orm";
import Link from "next/link";
import { getUserBillingSummary } from "@/lib/billing";

function planLabel(planId: string): string {
  if (planId === "plan_enterprise") return "Enterprise";
  if (planId === "plan_pro") return "Pro";
  return "Free";
}

export default async function DashboardPage() {
  const session = await getServerSession();
  if (!session) return null;

  const memberships = await db.query.member.findMany({
    where: eq(member.userId, session.user.id),
  });
  const accountBilling = await getUserBillingSummary(session.user.id);
  const ownedOrganizations = memberships.filter((membership) => membership.role === "owner").length;

  const orgs = await Promise.all(
    memberships.map(async (m) => {
      const org = await db.query.organization.findFirst({
        where: eq(organization.id, m.organizationId),
      });
      return { org, role: m.role };
    }),
  );

  return (
    <div className="space-y-8">
      <section className="rounded-lg border border-border/70 bg-card/80 p-6 shadow-[0_24px_80px_rgba(0,0,0,0.18)]">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-2xl space-y-3">
            <div className="inline-flex items-center gap-2 rounded-full border border-primary/15 bg-primary/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-primary">
              Workspace Overview
            </div>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">
                Welcome back, {session.user.name}
              </h1>
              <p className="mt-2 text-sm text-muted-foreground">
                Manage your organizations, account plan and workspace settings from one place.
              </p>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3 lg:min-w-[28rem]">
            <div className="rounded-md border border-border/70 bg-background/70 p-4">
              <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                Organizations
              </p>
              <p className="mt-2 text-2xl font-semibold text-foreground">{orgs.length}</p>
            </div>
            <div className="rounded-md border border-border/70 bg-background/70 p-4">
              <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Owned</p>
              <p className="mt-2 text-2xl font-semibold text-foreground">{ownedOrganizations}</p>
            </div>
            <div className="rounded-md border border-border/70 bg-background/70 p-4">
              <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                Account Plan
              </p>
              <p className="mt-2 text-2xl font-semibold text-foreground">
                {planLabel(accountBilling.planId)}
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <div className="grid gap-4 sm:grid-cols-2">
          <Link
            href="/dashboard/billing"
            className="group rounded-lg border border-border/70 bg-card/80 p-5 transition-colors hover:bg-accent/40"
          >
            <div className="flex h-11 w-11 items-center justify-center rounded-md bg-primary/10 text-primary">
              <span className="text-sm font-semibold">B</span>
            </div>
            <p className="mt-5 text-lg font-semibold text-foreground">Account Billing</p>
            <p className="mt-2 text-sm text-muted-foreground">
              Your current plan is {planLabel(accountBilling.planId)} and it controls organization
              limits.
            </p>
            <span className="mt-4 inline-flex items-center gap-2 text-sm font-medium text-primary">
              Manage billing
              <span className="transition-transform group-hover:translate-x-0.5">&rarr;</span>
            </span>
          </Link>

          <Link
            href="/dashboard/organizations"
            className="group rounded-lg border border-border/70 bg-card/80 p-5 transition-colors hover:bg-accent/40"
          >
            <div className="flex h-11 w-11 items-center justify-center rounded-md bg-fuchsia-500/10 text-fuchsia-300">
              <span className="text-sm font-semibold">O</span>
            </div>
            <p className="mt-5 text-lg font-semibold text-foreground">Organizations</p>
            <p className="mt-2 text-sm text-muted-foreground">
              Jump into your teams, members and project access with a cleaner navigation flow.
            </p>
            <span className="mt-4 inline-flex items-center gap-2 text-sm font-medium text-primary">
              Open organizations
              <span className="transition-transform group-hover:translate-x-0.5">&rarr;</span>
            </span>
          </Link>
        </div>

        <div className="rounded-lg border border-border/70 bg-card/80 p-6">
          <h2 className="text-lg font-semibold text-foreground">Quick Actions</h2>
          <div className="mt-5 space-y-3">
            <Link
              href="/dashboard/organizations/new"
              className="flex items-center justify-between rounded-md border border-border/70 bg-background/70 p-4 transition-colors hover:bg-accent/40"
            >
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <span className="text-base font-semibold">+</span>
                </div>
                <div>
                  <p className="text-sm font-medium text-foreground">Create organization</p>
                  <p className="text-xs text-muted-foreground">
                    Start a new workspace for your team
                  </p>
                </div>
              </div>
              <span className="text-muted-foreground">&rarr;</span>
            </Link>

            <Link
              href="/dashboard/settings"
              className="flex items-center justify-between rounded-md border border-border/70 bg-background/70 p-4 transition-colors hover:bg-accent/40"
            >
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-md bg-white/5 text-muted-foreground">
                  <span className="text-sm font-semibold">S</span>
                </div>
                <div>
                  <p className="text-sm font-medium text-foreground">Account settings</p>
                  <p className="text-xs text-muted-foreground">
                    Review profile and workspace preferences
                  </p>
                </div>
              </div>
              <span className="text-muted-foreground">&rarr;</span>
            </Link>
          </div>
        </div>
      </section>

      {orgs.length > 0 && (
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium uppercase tracking-[0.18em] text-muted-foreground">
              Your Organizations
            </h2>
            <Link
              href="/dashboard/organizations"
              className="text-sm font-medium text-primary hover:underline"
            >
              View all
            </Link>
          </div>
          <div className="space-y-2">
            {orgs.map(({ org, role }) =>
              org ? (
                <Link
                  key={org.id}
                  href={`/dashboard/organizations/${org.id}`}
                  className="group flex items-center justify-between rounded-lg border border-border/70 bg-card/80 p-4 transition-colors hover:bg-accent/40"
                >
                  <div className="flex items-center gap-4">
                    <div className="flex h-11 w-11 items-center justify-center rounded-md bg-primary/10 text-sm font-semibold text-primary">
                      {org.name.charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <p className="text-sm font-medium text-foreground transition-colors group-hover:text-primary">
                        {org.name}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">/{org.slug}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="rounded-full border border-border/70 bg-background/70 px-2.5 py-1 text-[11px] text-muted-foreground capitalize">
                      {role}
                    </span>
                    <span className="text-muted-foreground transition-transform group-hover:translate-x-0.5">
                      &rarr;
                    </span>
                  </div>
                </Link>
              ) : null,
            )}
          </div>
        </section>
      )}

      {orgs.length === 0 && (
        <div className="rounded-lg border border-border/70 bg-card/50 p-12 text-center">
          <p className="text-sm text-muted-foreground">
            You don&apos;t have any organizations yet.
          </p>
          <Link
            href="/dashboard/organizations/new"
            className="mt-4 inline-flex items-center justify-center h-9 px-4 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:brightness-110 transition-all"
          >
            Create Organization
          </Link>
        </div>
      )}
    </div>
  );
}
