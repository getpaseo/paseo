import { getServerSession } from "@/lib/session";
import { db } from "@/lib/db";
import { member, organization } from "@/db/schema";
import { eq } from "drizzle-orm";
import Link from "next/link";

export default async function OrganizationsPage() {
  const session = await getServerSession();
  if (!session) return null;

  const memberships = await db.query.member.findMany({
    where: eq(member.userId, session.user.id),
  });

  const orgs = await Promise.all(
    memberships.map(async (m) => {
      const org = await db.query.organization.findFirst({
        where: eq(organization.id, m.organizationId),
      });
      const memberCount = (
        await db.query.member.findMany({
          where: eq(member.organizationId, m.organizationId),
        })
      ).length;
      return { org, role: m.role, memberCount };
    }),
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-foreground">Organizations</h1>
          <p className="mt-1 text-sm text-muted-foreground">Manage your organizations and teams</p>
        </div>
        <Link
          href="/dashboard/organizations/new"
          className="inline-flex items-center justify-center h-9 px-4 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:brightness-110 transition-all"
        >
          New Organization
        </Link>
      </div>

      <div className="space-y-1.5">
        {orgs.map(({ org, role, memberCount }) =>
          org ? (
            <Link
              key={org.id}
              href={`/dashboard/organizations/${org.id}`}
              className="group flex items-center justify-between rounded-lg border border-border bg-card p-4 transition-all hover:bg-accent hover:border-border/80"
            >
              <div>
                <p className="text-sm font-medium text-foreground group-hover:text-primary transition-colors">
                  {org.name}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  /{org.slug} &middot; {memberCount} member{memberCount !== 1 ? "s" : ""}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-[11px] text-muted-foreground capitalize">{role}</span>
              </div>
            </Link>
          ) : null,
        )}

        {orgs.length === 0 && (
          <div className="rounded-lg border border-dashed border-border p-12 text-center">
            <p className="text-sm text-muted-foreground">No organizations yet.</p>
          </div>
        )}
      </div>
    </div>
  );
}
