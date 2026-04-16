import { getServerSession } from "@/lib/session";
import { redirect } from "next/navigation";

export default async function SettingsPage() {
  const session = await getServerSession();
  if (!session) redirect("/sign-in/web");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-foreground">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">Manage your account settings</p>
      </div>

      <div className="rounded-lg border border-border bg-card p-6 space-y-4">
        <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
          Profile
        </h2>
        <div className="flex items-center gap-4">
          {session.user.image ? (
            <img
              src={session.user.image}
              alt={session.user.name}
              className="h-14 w-14 rounded-full ring-2 ring-border"
            />
          ) : (
            <div className="h-14 w-14 rounded-full bg-secondary flex items-center justify-center">
              <span className="text-lg font-medium text-muted-foreground">
                {session.user.name?.charAt(0)?.toUpperCase()}
              </span>
            </div>
          )}
          <div>
            <p className="text-sm font-medium text-foreground">{session.user.name}</p>
            <p className="text-xs text-muted-foreground">{session.user.email}</p>
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card p-6 space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
          Account
        </h2>
        <p className="text-sm text-muted-foreground">
          Your account is managed through your OAuth provider (GitHub or Google). To update your
          name or email, update it with your provider.
        </p>
      </div>
    </div>
  );
}
