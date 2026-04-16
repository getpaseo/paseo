"use client";

import { useEffect, useState, useCallback } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

type Status = "checking" | "not-logged-in" | "ready" | "loading" | "accepted" | "error";

export default function AcceptInvitePage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const invitationId = searchParams.get("id");
  const orgId = searchParams.get("org");
  const [status, setStatus] = useState<Status>("checking");
  const [error, setError] = useState<string | null>(null);
  const [orgName, setOrgName] = useState<string>("");
  const [userName, setUserName] = useState<string>("");

  // Check if user is logged in
  useEffect(() => {
    if (!invitationId || !orgId) {
      setStatus("error");
      setError("Invalid invitation link");
      return;
    }

    fetch("/api/auth/get-session", { credentials: "include" })
      .then((r) => r.json())
      .then((data) => {
        if (data?.user) {
          setUserName(data.user.name || "");
          setStatus("ready");
        } else {
          setStatus("not-logged-in");
        }
      })
      .catch(() => setStatus("not-logged-in"));
  }, [invitationId, orgId]);

  const handleSignIn = () => {
    // Save the invite URL so we can come back after login
    const returnUrl = `/invite/accept?id=${invitationId}&org=${orgId}`;
    router.push(`/sign-in/web?callbackUrl=${encodeURIComponent(returnUrl)}`);
  };

  const handleAccept = async () => {
    setStatus("loading");
    try {
      const res = await fetch(`/api/invite/accept`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invitationId, orgId }),
      });

      const data = await res.json();

      if (res.status === 401) {
        setStatus("not-logged-in");
        return;
      }

      if (!res.ok) {
        setStatus("error");
        setError(data.error || "Failed to accept invitation");
        return;
      }

      setOrgName(data.organizationName || "");
      setStatus("accepted");
      setTimeout(() => {
        router.push(`/dashboard/organizations/${orgId}`);
      }, 2000);
    } catch {
      setStatus("error");
      setError("Something went wrong");
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="w-full max-w-md text-center space-y-6 px-4">
        {/* Logo */}
        <div className="flex items-center justify-center gap-2 mb-8">
          <img src="/logo-icon-hubcode.png" alt="Hubcode" className="h-8 w-8 rounded-lg" />
          <span className="text-lg font-semibold text-foreground">Hubcode</span>
        </div>

        {/* Checking session */}
        {status === "checking" && (
          <div className="rounded-lg border border-border bg-card p-8 space-y-4">
            <div className="h-6 w-6 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto" />
            <p className="text-sm text-muted-foreground">Loading...</p>
          </div>
        )}

        {/* Not logged in — friendly sign-in prompt */}
        {status === "not-logged-in" && (
          <div className="rounded-lg border border-border bg-card p-8 space-y-5">
            <div className="h-14 w-14 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center mx-auto">
              <svg
                className="h-7 w-7 text-primary"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <line x1="19" y1="8" x2="19" y2="14" />
                <line x1="22" y1="11" x2="16" y2="11" />
              </svg>
            </div>
            <div className="space-y-2">
              <h1 className="text-xl font-semibold text-foreground">You've been invited!</h1>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Someone invited you to join their team on Hubcode. Sign in or create an account to
                accept the invitation.
              </p>
            </div>
            <div className="space-y-3 pt-2">
              <Button size="lg" fullWidth onClick={handleSignIn}>
                Sign in to accept
              </Button>
              <p className="text-xs text-muted-foreground/50">
                Don't have an account? You'll be able to create one.
              </p>
            </div>
          </div>
        )}

        {/* Logged in — ready to accept */}
        {status === "ready" && (
          <div className="rounded-lg border border-border bg-card p-8 space-y-5">
            <div className="h-14 w-14 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center mx-auto">
              <svg
                className="h-7 w-7 text-primary"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <line x1="19" y1="8" x2="19" y2="14" />
                <line x1="22" y1="11" x2="16" y2="11" />
              </svg>
            </div>
            <div className="space-y-2">
              <h1 className="text-xl font-semibold text-foreground">Team Invitation</h1>
              <p className="text-sm text-muted-foreground leading-relaxed">
                {userName ? (
                  <>
                    Hi <span className="text-foreground font-medium">{userName}</span>! You've
                  </>
                ) : (
                  <>You've</>
                )}{" "}
                been invited to join a team on Hubcode. Click below to accept.
              </p>
            </div>
            <Button size="lg" fullWidth onClick={handleAccept}>
              Accept Invitation
            </Button>
          </div>
        )}

        {/* Loading / processing */}
        {status === "loading" && (
          <div className="rounded-lg border border-border bg-card p-8 space-y-4">
            <div className="h-6 w-6 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto" />
            <p className="text-sm text-muted-foreground">Joining the team...</p>
          </div>
        )}

        {/* Accepted */}
        {status === "accepted" && (
          <div className="rounded-lg border border-border bg-card p-8 space-y-4">
            <div className="h-14 w-14 rounded-full bg-green-500/10 border border-green-500/20 flex items-center justify-center mx-auto">
              <svg
                className="h-7 w-7 text-green-500"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h1 className="text-xl font-semibold text-foreground">Welcome!</h1>
            <p className="text-sm text-muted-foreground">
              You've joined{" "}
              <span className="text-foreground font-medium">{orgName || "the team"}</span>.
              Redirecting...
            </p>
          </div>
        )}

        {/* Error */}
        {status === "error" && (
          <div className="rounded-lg border border-border bg-card p-8 space-y-5">
            <div className="h-14 w-14 rounded-full bg-destructive/10 border border-destructive/20 flex items-center justify-center mx-auto">
              <svg
                className="h-7 w-7 text-destructive"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="10" />
                <line x1="15" y1="9" x2="9" y2="15" />
                <line x1="9" y1="9" x2="15" y2="15" />
              </svg>
            </div>
            <div className="space-y-2">
              <h1 className="text-xl font-semibold text-foreground">Something went wrong</h1>
              <p className="text-sm text-muted-foreground">{error}</p>
            </div>
            <div className="space-y-2 pt-1">
              <Button variant="secondary" fullWidth onClick={handleSignIn}>
                Try signing in again
              </Button>
              <Button variant="ghost" fullWidth onClick={() => router.push("/dashboard")}>
                Go to Dashboard
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
