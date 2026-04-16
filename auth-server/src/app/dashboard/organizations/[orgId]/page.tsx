import { getServerSession } from "@/lib/session";
import { db } from "@/lib/db";
import { organization, member, user } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { getOrgFeatures } from "@/lib/feature-flags";
import { redirect } from "next/navigation";
import Link from "next/link";

export default async function OrgDetailPage({ params }: { params: Promise<{ orgId: string }> }) {
  const session = await getServerSession();
  if (!session) redirect("/sign-in/web");

  const { orgId } = await params;

  const membership = await db.query.member.findFirst({
    where: and(eq(member.organizationId, orgId), eq(member.userId, session.user.id)),
  });
  if (!membership) redirect("/dashboard/organizations");

  const org = await db.query.organization.findFirst({
    where: eq(organization.id, orgId),
  });
  if (!org) redirect("/dashboard/organizations");

  const members = await db.query.member.findMany({
    where: eq(member.organizationId, orgId),
  });

  const membersWithUsers = await Promise.all(
    members.map(async (m) => {
      const u = await db.query.user.findFirst({ where: eq(user.id, m.userId) });
      return { ...m, user: u };
    }),
  );

  const features = await getOrgFeatures(orgId);
  const isOwnerOrAdmin = ["owner", "admin"].includes(membership.role);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-lg font-semibold text-foreground">{org.name}</h1>
        <p className="text-xs text-muted-foreground mt-0.5">/{org.slug}</p>
      </div>

      {/* Members */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
            Members ({members.length}
            {features.max_members && features.max_members !== "unlimited"
              ? `/${features.max_members}`
              : ""}
            )
          </h2>
          {isOwnerOrAdmin && (
            <Link
              href={`/dashboard/organizations/${orgId}/members`}
              className="inline-flex items-center justify-center h-7 px-2.5 rounded-lg text-xs font-medium bg-primary text-primary-foreground hover:brightness-110 transition-all"
            >
              Manage Members
            </Link>
          )}
        </div>
        <div className="space-y-1">
          {membersWithUsers.map((m) => (
            <div
              key={m.id}
              className="flex items-center justify-between rounded-lg border border-border bg-card px-4 py-3"
            >
              <div className="flex items-center gap-3">
                {m.user?.image ? (
                  <img
                    src={m.user.image}
                    alt=""
                    className="h-7 w-7 rounded-full ring-1 ring-border"
                  />
                ) : (
                  <div className="h-7 w-7 rounded-full bg-secondary flex items-center justify-center">
                    <span className="text-[10px] font-medium text-muted-foreground">
                      {m.user?.name?.charAt(0)?.toUpperCase() ?? "?"}
                    </span>
                  </div>
                )}
                <div>
                  <p className="text-sm font-medium text-foreground">{m.user?.name ?? "Unknown"}</p>
                  <p className="text-[11px] text-muted-foreground">{m.user?.email}</p>
                </div>
              </div>
              <span className="rounded-full bg-secondary px-2.5 py-0.5 text-[11px] font-medium capitalize text-secondary-foreground">
                {m.role}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Quick links */}
      <div className="grid gap-3 sm:grid-cols-1">
        <Link
          href={`/dashboard/organizations/${orgId}/members`}
          className="group rounded-lg border border-border bg-card p-4 transition-all hover:bg-accent hover:border-border/80"
        >
          <p className="text-sm font-medium text-foreground group-hover:text-primary transition-colors">
            Team
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {members.length} member{members.length !== 1 ? "s" : ""}
          </p>
        </Link>
      </div>
    </div>
  );
}
