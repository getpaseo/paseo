import { db } from "@/lib/db";
import { sessionShare, user } from "@/db/schema";
import { eq, and, gt } from "drizzle-orm";
import { getServerSession } from "@/lib/session";
import Link from "next/link";

export default async function JoinSessionPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const session = await getServerSession();

  const share = await db.query.sessionShare.findFirst({
    where: and(eq(sessionShare.token, token), gt(sessionShare.expiresAt, new Date())),
  });

  if (!share) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="w-full max-w-sm px-4 text-center space-y-4">
          <h1 className="text-xl font-semibold text-foreground">Link expired</h1>
          <p className="text-sm text-muted-foreground">
            This session share link is no longer valid.
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
    const callbackUrl = encodeURIComponent(`/join/${token}`);
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="w-full max-w-sm px-4 text-center space-y-4">
          <h1 className="text-xl font-semibold text-foreground">Join shared session</h1>
          <p className="text-sm text-muted-foreground">
            <span className="text-foreground font-medium">{owner?.name ?? "Someone"}</span> invited
            you to a{" "}
            {share.accessLevel === "full_access" ? "collaborative" : "view-only"} session.
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

  // User is authenticated — show join page
  const webAppUrl = process.env.HUBCODE_WEB_APP_URL || null;
  const sessionToken = (session as any)?.session?.token ?? "";

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="w-full max-w-md px-4">
        <div className="rounded-lg border border-border bg-card p-6 space-y-5">
          <div className="text-center space-y-2">
            <div className="inline-flex items-center gap-2 rounded-full border border-primary/15 bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
              {share.accessLevel === "full_access" ? "Full access" : "View only"}
            </div>
            <h1 className="text-lg font-semibold text-foreground">Join shared session</h1>
            <p className="text-sm text-muted-foreground">
              <span className="text-foreground font-medium">{owner?.name ?? "Someone"}</span> is
              sharing an agent session with you.
            </p>
          </div>

          <div className="rounded-md border border-border bg-background/50 p-4 space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Session</span>
              <span className="text-foreground font-mono text-xs">{share.daemonSessionId.slice(0, 8)}...</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Access</span>
              <span className="text-foreground">
                {share.accessLevel === "full_access" ? "Can interact with agent" : "View only"}
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
                href={`hubcode://join/${token}`}
                className="inline-flex h-9 px-4 items-center justify-center rounded-md text-sm font-medium bg-primary text-primary-foreground hover:brightness-110 transition-all"
              >
                Open in Desktop App
              </a>
              {webAppUrl && (
                <a
                  href={`${webAppUrl}/join/${token}?st=${sessionToken}`}
                  className="inline-flex h-9 px-4 items-center justify-center rounded-md text-sm font-medium border border-border text-foreground hover:bg-accent transition-all"
                >
                  Open in Browser
                </a>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              The desktop app will open automatically. If it doesn&apos;t,{" "}
              <a href={`hubcode://join/${token}`} className="text-primary hover:underline">
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
