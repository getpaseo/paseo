import { db } from "@/lib/db";
import { workspaceShare, user, member } from "@/db/schema";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { getServerSession } from "@/lib/session";
import Image from "next/image";
import Link from "next/link";
import { JoinCard } from "./join-card";

function BrandHeader() {
  return (
    <div className="flex flex-col items-center gap-2 pb-8">
      <Image
        src="/logo-hubcode.png"
        alt="Hubcode"
        width={160}
        height={40}
        priority
        className="h-10 w-auto"
      />
    </div>
  );
}

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
      <div className="flex min-h-screen flex-col items-center justify-center bg-background">
        <BrandHeader />
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
      <div className="flex min-h-screen flex-col items-center justify-center bg-background">
        <BrandHeader />
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
      <div className="flex min-h-screen flex-col items-center justify-center bg-background">
        <BrandHeader />
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

  const viewer = await db.query.user.findFirst({
    where: eq(user.id, sessionUserId),
  });

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background py-10">
      <BrandHeader />
      <JoinCard
        token={token}
        workspaceName={share.workspaceName}
        projectName={share.projectName}
        accessLevel={share.accessLevel === "full_access" ? "full_access" : "read_only"}
        ownerName={owner?.name ?? "Someone"}
        ownerImage={owner?.image ?? null}
        viewerName={viewer?.name ?? "You"}
        viewerImage={viewer?.image ?? null}
        webAppUrl={webAppUrl}
        sessionToken={sessionToken}
      />
    </div>
  );
}
