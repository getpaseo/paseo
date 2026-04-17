import { db } from "@/lib/db";
import { workspaceShare, user, member } from "@/db/schema";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { getServerSession } from "@/lib/session";
import Link from "next/link";

export default async function JoinWorkspacePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const session = await getServerSession();

  const share = await db.query.workspaceShare.findFirst({
    where: and(
      eq(workspaceShare.token, token),
      isNull(workspaceShare.revokedAt),
      or(isNull(workspaceShare.expiresAt), gt(workspaceShare.expiresAt, new Date())),
    ),
  });

  if (!share) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="w-full max-w-sm px-4 text-center space-y-4">
          <h1 className="text-xl font-semibold text-foreground">Link unavailable</h1>
          <p className="text-sm text-muted-foreground">
            This workspace share link is no longer valid.
          </p>
          <Link
            href="/dashboard"
            className="inline-flex h-9 px-4 items-center rounded-md text-sm font-medium bg-primary text-primary-foreground hover:brightness-110 transition-all"
          >
            Go to dashboard
          </Link>
        </div>
      </div>
    );
  }

  const owner = await db.query.user.findFirst({
    where: eq(user.id, share.ownerId),
  });

  if (!session) {
    const callbackUrl = encodeURIComponent(`/join-workspace/${token}`);
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="w-full max-w-sm px-4 text-center space-y-4">
          <h1 className="text-xl font-semibold text-foreground">Join shared workspace</h1>
          <p className="text-sm text-muted-foreground">
            <span className="text-foreground font-medium">{owner?.name ?? "Someone"}</span> invited
            you to a {share.accessLevel === "full_access" ? "collaborative" : "view-only"}{" "}
            workspace.
          </p>
          <p className="text-sm text-muted-foreground">Sign in to continue.</p>
          <Link
            href={`/sign-in/web?callbackUrl=${callbackUrl}`}
            className="inline-flex h-9 px-4 items-center rounded-md text-sm font-medium bg-primary text-primary-foreground hover:brightness-110 transition-all"
          >
            Sign in
          </Link>
        </div>
      </div>
    );
  }

  const sessionUserId = (session as { user?: { id?: string } }).user?.id ?? "";

  const allowedIds = (share.allowedUserIds as string[]) ?? [];
  const isOwner = share.ownerId === sessionUserId;
  const isAllowedUser = isOwner || allowedIds.length === 0 || allowedIds.includes(sessionUserId);

  const membership = sessionUserId
    ? await db.query.member.findFirst({
        where: and(eq(member.organizationId, share.orgId), eq(member.userId, sessionUserId)),
      })
    : null;

  if (!isAllowedUser || !membership) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="w-full max-w-sm px-4 text-center space-y-4">
          <h1 className="text-xl font-semibold text-foreground">Access denied</h1>
          <p className="text-sm text-muted-foreground">
            {!membership
              ? "You are not a member of the organization that owns this workspace."
              : "You were not invited to this workspace."}
          </p>
          <Link
            href="/dashboard"
            className="inline-flex h-9 px-4 items-center rounded-md text-sm font-medium bg-primary text-primary-foreground hover:brightness-110 transition-all"
          >
            Go to dashboard
          </Link>
        </div>
      </div>
    );
  }

  const webAppUrl = process.env.HUBCODE_WEB_APP_URL || null;
  const sessionToken = (session as { session?: { token?: string } }).session?.token ?? "";

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="w-full max-w-md px-4">
        <div className="rounded-lg border border-border bg-card p-6 space-y-5">
          <div className="text-center space-y-2">
            <div className="inline-flex items-center gap-2 rounded-full border border-primary/15 bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
              {share.accessLevel === "full_access" ? "Full access" : "View only"}
            </div>
            <h1 className="text-lg font-semibold text-foreground">Join shared workspace</h1>
            <p className="text-sm text-muted-foreground">
              <span className="text-foreground font-medium">{owner?.name ?? "Someone"}</span> is
              sharing a workspace with you.
            </p>
          </div>

          <div className="rounded-md border border-border bg-background/50 p-4 space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Project</span>
              <span className="text-foreground">{share.projectName}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Workspace</span>
              <span className="text-foreground">{share.workspaceName}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Access</span>
              <span className="text-foreground">
                {share.accessLevel === "full_access" ? "Can interact" : "View only"}
              </span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Shared by</span>
              <span className="text-foreground">{owner?.name ?? "Unknown"}</span>
            </div>
          </div>

          <div className="text-center space-y-3">
            <div className="flex flex-col gap-2">
              <a
                href={`hubcode://join-workspace/${token}`}
                className="inline-flex h-9 px-4 items-center justify-center rounded-md text-sm font-medium bg-primary text-primary-foreground hover:brightness-110 transition-all"
              >
                Open in Desktop App
              </a>
              {webAppUrl && (
                <a
                  href={`${webAppUrl}/join-workspace/${token}?st=${sessionToken}`}
                  className="inline-flex h-9 px-4 items-center justify-center rounded-md text-sm font-medium border border-border text-foreground hover:bg-accent transition-all"
                >
                  Open in Browser
                </a>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              The desktop app will open automatically. If it doesn&apos;t,{" "}
              <a
                href={`hubcode://join-workspace/${token}`}
                className="text-primary hover:underline"
              >
                try again
              </a>
              .
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
