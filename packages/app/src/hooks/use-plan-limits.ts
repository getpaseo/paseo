// Plan-limits hook — reads /api/me/plan-limits on the auth-server and
// exposes the user's resolved plan + limits + flags + current usage.
//
// All gating UI uses this. Components don't talk to the auth-server
// directly; they consume the cached query so the modal+lock-icon visuals
// update consistently across screens. Stale time of 30s is short enough
// to feel responsive after Stripe webhook → billing-stream invalidation,
// long enough to avoid hammering on every render.

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuthSession } from "@/desktop/hooks/use-auth-session";
import { authServerBaseUrl } from "@/desktop/auth/web-auth-api";

export interface PlanLimitValue {
  /** Raw string from the DB (e.g. "5", "unlimited"). */
  value: string;
  /** Numeric form. -1 means unlimited (JSON-safe sentinel for Infinity). */
  numeric: number;
  isUnlimited: boolean;
}

export interface PlanLimitsBundle {
  planId: string;
  status: string;
  isActive: boolean;
  limits: {
    max_organizations: PlanLimitValue;
    max_members_per_org: PlanLimitValue;
    max_concurrent_shared_sessions: PlanLimitValue;
    max_active_skills: PlanLimitValue;
    max_active_mcps: PlanLimitValue;
    max_issue_integrations: PlanLimitValue;
    max_attachments_storage_gb: PlanLimitValue;
    message_retention_days: PlanLimitValue;
    max_session_duration_minutes: PlanLimitValue;
  };
  flags: {
    hubcode_agent_enabled: boolean;
    messages_enabled: boolean;
    audit_log_enabled: boolean;
    sso_enabled: boolean;
  };
  support: { tier: string };
  usage: {
    organizations: number;
    membersInLargestOrg: number;
    activeSharedSessions: number;
    pendingMessagesAttachmentsBytes: number;
  };
}

const QUERY_KEY = ["planLimits"] as const;

async function fetchPlanLimits(sessionToken: string | null): Promise<PlanLimitsBundle | null> {
  try {
    const url = `${authServerBaseUrl()}/api/me/plan-limits`;
    const res = await fetch(url, {
      credentials: "include",
      headers: sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {},
    });
    if (!res.ok) return null;
    return (await res.json()) as PlanLimitsBundle;
  } catch {
    return null;
  }
}

export function usePlanLimits(): {
  bundle: PlanLimitsBundle | null;
  isLoading: boolean;
  refetch: () => void;
} {
  const { isAuthenticated, isVerified, session } = useAuthSession();
  const sessionToken = session?.sessionToken ?? null;
  const query = useQuery<PlanLimitsBundle | null>({
    queryKey: [...QUERY_KEY, sessionToken],
    // Three gates, in order of looseness:
    //   isVerified       — the session-revalidation refetch has settled,
    //                      so the cached `session` we're reading isn't
    //                      a leftover from a previous app run with an
    //                      expired token.
    //   isAuthenticated  — server agrees we have a session.
    //   sessionToken     — bearer token is in the store, ready to send.
    enabled: isVerified && isAuthenticated && !!sessionToken,
    staleTime: 30_000,
    // Don't retry — a 401 means the cookie/token is stale; retrying just
    // re-spams the console. The hook's consumer treats `null` as "needs
    // sign-in" and renders the appropriate CTA.
    retry: false,
    queryFn: () => fetchPlanLimits(sessionToken),
  });
  return {
    bundle: query.data ?? null,
    isLoading: query.isLoading,
    refetch: () => {
      void query.refetch();
    },
  };
}

// ── Convenience helpers ────────────────────────────────────────────────

/**
 * Returns a bool + reason describing whether `featureKey` (a flag) is
 * enabled for the user's current plan. `null` reason if allowed; an
 * upgrade-prompt string otherwise. Used by `<UpgradeRequiredModal />`
 * + every "lock" badge.
 */
export function checkFlag(
  bundle: PlanLimitsBundle | null,
  featureKey: keyof PlanLimitsBundle["flags"],
): { allowed: boolean; reason: string | null } {
  if (!bundle) return { allowed: false, reason: "Loading your plan…" };
  return bundle.flags[featureKey]
    ? { allowed: true, reason: null }
    : {
        allowed: false,
        reason: `This feature is not included in your ${planDisplayName(bundle.planId)} plan.`,
      };
}

/**
 * Returns whether adding ONE MORE counted resource is allowed under the
 * user's plan. Pass the current count BEFORE the new resource. -1 =
 * unlimited (always allowed).
 */
export function checkCount(
  bundle: PlanLimitsBundle | null,
  limitKey: keyof PlanLimitsBundle["limits"],
  currentCount: number,
): { allowed: boolean; reason: string | null; limit: number; isUnlimited: boolean } {
  if (!bundle) {
    return { allowed: false, reason: "Loading your plan…", limit: 0, isUnlimited: false };
  }
  const limit = bundle.limits[limitKey];
  if (limit.isUnlimited) {
    return { allowed: true, reason: null, limit: Number.POSITIVE_INFINITY, isUnlimited: true };
  }
  const allowed = currentCount < limit.numeric;
  return {
    allowed,
    reason: allowed
      ? null
      : `You hit the ${planDisplayName(bundle.planId)} plan limit (${currentCount}/${limit.numeric}).`,
    limit: limit.numeric,
    isUnlimited: false,
  };
}

export function planDisplayName(planId: string): string {
  if (planId === "plan_free") return "Free";
  if (planId === "plan_pro") return "Pro";
  if (planId === "plan_enterprise") return "Enterprise";
  return planId;
}

/**
 * Free-tier session countdown. Returns the minutes/seconds remaining for
 * an agent session that started at `sessionStartedAt`, or `null` if the
 * user's plan has unlimited session duration. The caller is responsible
 * for ending the session gracefully when `secondsRemaining <= 0` — this
 * hook only computes the countdown.
 *
 * Pricing intentionally caps free at 60 minutes so unattended bots can't
 * sit idle forever; the gate is enforced server-side via
 * `max_session_duration_minutes` in plan_feature.
 */
export function useSessionTimeRemaining(
  bundle: PlanLimitsBundle | null,
  sessionStartedAt: number | null,
): {
  hasLimit: boolean;
  totalMinutes: number;
  secondsRemaining: number;
  expired: boolean;
} {
  const limit = bundle?.limits.max_session_duration_minutes;
  const hasLimit = !!limit && !limit.isUnlimited && limit.numeric > 0;
  const totalMinutes = hasLimit ? limit!.numeric : 0;

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!hasLimit || !sessionStartedAt) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [hasLimit, sessionStartedAt]);

  if (!hasLimit || !sessionStartedAt) {
    return { hasLimit: false, totalMinutes: 0, secondsRemaining: 0, expired: false };
  }
  const elapsedMs = now - sessionStartedAt;
  const totalMs = totalMinutes * 60 * 1000;
  const secondsRemaining = Math.max(0, Math.floor((totalMs - elapsedMs) / 1000));
  return { hasLimit: true, totalMinutes, secondsRemaining, expired: secondsRemaining <= 0 };
}

/** The plan one tier above the user's, used by the upgrade CTA. */
export function recommendedUpgrade(planId: string): {
  id: "plan_pro" | "plan_enterprise";
  label: "Pro" | "Enterprise";
} {
  if (planId === "plan_enterprise") return { id: "plan_enterprise", label: "Enterprise" };
  if (planId === "plan_pro") return { id: "plan_enterprise", label: "Enterprise" };
  return { id: "plan_pro", label: "Pro" };
}
