"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";

interface Member {
  id: string;
  userId: string;
  role: string;
  user: { id: string; name: string; email: string; image: string | null } | null;
}

interface Invitation {
  id: string;
  email: string;
  role: string;
  status: string;
  expiresAt: string | null;
  createdAt: string;
}

export default function MembersPage() {
  const { orgId } = useParams<{ orgId: string }>();
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [cancelingId, setCancelingId] = useState<string | null>(null);
  const [resendingId, setResendingId] = useState<string | null>(null);

  const fetchMembers = useCallback(async () => {
    const res = await fetch(`/api/organizations/${orgId}/members`, {
      credentials: "include",
    });
    if (res.ok) {
      const data = await res.json();
      setMembers(data.members);
      setInvitations(data.invitations);
    }
  }, [orgId]);

  useEffect(() => {
    fetchMembers();
  }, [fetchMembers]);

  const showSuccess = (msg: string) => {
    setSuccess(msg);
    setTimeout(() => setSuccess(null), 3000);
  };

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await fetch(`/api/organizations/${orgId}/members`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, role }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to invite member");
      }

      const data = await res.json();
      setEmail("");
      await fetchMembers();

      if (data.status === "accepted") {
        showSuccess(`${email} was added to the team`);
      } else if (data.emailSent) {
        showSuccess(`Invitation email sent to ${email}`);
      } else {
        showSuccess(`Invitation created for ${email}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = async (invitationId: string) => {
    setCancelingId(invitationId);
    try {
      const res = await fetch(`/api/organizations/${orgId}/invitations/${invitationId}`, {
        method: "DELETE",
        credentials: "include",
      });

      if (res.ok) {
        await fetchMembers();
        showSuccess("Invitation canceled");
      } else {
        const data = await res.json();
        setError(data.error || "Failed to cancel invitation");
      }
    } catch {
      setError("Failed to cancel invitation");
    } finally {
      setCancelingId(null);
    }
  };

  const handleResend = async (invitationId: string) => {
    setResendingId(invitationId);
    try {
      const res = await fetch(`/api/organizations/${orgId}/invitations/${invitationId}`, {
        method: "POST",
        credentials: "include",
      });

      if (res.ok) {
        showSuccess("Invitation email resent");
      } else {
        const data = await res.json();
        setError(data.error || "Failed to resend invitation");
      }
    } catch {
      setError("Failed to resend invitation");
    } finally {
      setResendingId(null);
    }
  };

  const handleRemove = async (memberId: string) => {
    if (!confirm("Remove this member?")) return;

    const res = await fetch(`/api/organizations/${orgId}/members/${memberId}`, {
      method: "DELETE",
      credentials: "include",
    });

    if (res.ok) {
      await fetchMembers();
      showSuccess("Member removed");
    }
  };

  const handleRoleChange = async (memberId: string, newRole: string) => {
    const res = await fetch(`/api/organizations/${orgId}/members/${memberId}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: newRole }),
    });

    if (res.ok) {
      await fetchMembers();
    }
  };

  const getTimeAgo = (dateStr: string) => {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  };

  const isExpired = (expiresAt: string | null) => {
    if (!expiresAt) return false;
    return new Date(expiresAt) < new Date();
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-lg font-semibold text-foreground">Members</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage your team members and invitations
        </p>
      </div>

      {/* Invite form */}
      <form onSubmit={handleInvite} className="flex gap-2">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          placeholder="Email address"
          className="flex-1 rounded-lg border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/30 transition-colors"
        />
        <select
          value={role}
          onChange={(e) => setRole(e.target.value)}
          className="rounded-lg border border-input bg-card px-3 py-2 text-sm text-foreground appearance-none cursor-pointer"
        >
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </select>
        <Button type="submit" disabled={loading}>
          {loading ? "Inviting..." : "Invite"}
        </Button>
      </form>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-2.5">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      {success && (
        <div className="rounded-lg border border-green-500/30 bg-green-500/10 px-4 py-2.5">
          <p className="text-sm text-green-400">{success}</p>
        </div>
      )}

      {/* Members list */}
      <div className="space-y-1">
        {members.map((m) => (
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
            <div className="flex items-center gap-2">
              {m.role !== "owner" ? (
                <>
                  <select
                    value={m.role}
                    onChange={(e) => handleRoleChange(m.id, e.target.value)}
                    className="rounded-lg border border-input bg-secondary px-2.5 py-1 text-xs text-secondary-foreground appearance-none cursor-pointer"
                  >
                    <option value="member">Member</option>
                    <option value="admin">Admin</option>
                  </select>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleRemove(m.id)}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    Remove
                  </Button>
                </>
              ) : (
                <span className="rounded-full bg-primary/10 border border-primary/20 px-2.5 py-0.5 text-[11px] font-medium text-primary">
                  Owner
                </span>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Pending invitations */}
      {invitations.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
            Pending Invitations
          </h2>
          <div className="space-y-1">
            {invitations.map((inv) => {
              const expired = isExpired(inv.expiresAt);
              return (
                <div
                  key={inv.id}
                  className={`flex items-center justify-between rounded-lg border bg-card px-4 py-3 ${
                    expired ? "border-yellow-500/20 opacity-60" : "border-dashed border-border"
                  }`}
                >
                  <div className="flex items-center gap-3">
                    {/* Email icon */}
                    <div className="h-7 w-7 rounded-full bg-primary/10 flex items-center justify-center">
                      <svg
                        className="h-3.5 w-3.5 text-primary"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <rect width="20" height="16" x="2" y="4" rx="2" />
                        <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
                      </svg>
                    </div>
                    <div>
                      <p className="text-sm text-foreground">{inv.email}</p>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-[10px] text-muted-foreground capitalize">
                          {inv.role}
                        </span>
                        <span className="text-[10px] text-muted-foreground/40">&middot;</span>
                        <span className="text-[10px] text-muted-foreground/60">
                          {inv.createdAt ? `Sent ${getTimeAgo(inv.createdAt)}` : "Sent"}
                        </span>
                        {expired && (
                          <>
                            <span className="text-[10px] text-muted-foreground/40">&middot;</span>
                            <span className="text-[10px] text-yellow-500 font-medium">Expired</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleResend(inv.id)}
                      disabled={resendingId === inv.id}
                      className="text-muted-foreground hover:text-primary"
                    >
                      {resendingId === inv.id ? (
                        <span className="h-3 w-3 border border-current border-t-transparent rounded-full animate-spin" />
                      ) : (
                        <svg
                          className="h-3.5 w-3.5 mr-1"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />
                        </svg>
                      )}
                      {resendingId === inv.id ? "Sending..." : "Resend"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleCancel(inv.id)}
                      disabled={cancelingId === inv.id}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      {cancelingId === inv.id ? "Canceling..." : "Cancel"}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
