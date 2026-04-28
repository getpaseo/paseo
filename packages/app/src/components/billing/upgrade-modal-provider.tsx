// Top-level provider that owns the single UpgradeRequiredModal instance
// and exposes two ways to open it from anywhere in the app:
//
//   1. `triggerUpgrade(...)` — manual fire (e.g. when a Pressable is
//      disabled because the lock badge is showing).
//   2. `handlePlanGateResponse(res)` — pass any fetch Response; if it's
//      a 402 with `code: "PLAN_GATE_DENIED"`, the modal opens with a
//      sensible default message and we return `true` so the caller can
//      bail out.
//
// Centralizing the modal here means every gated action gets the same
// conversion-oriented UX without each screen having to re-render the
// modal locally.

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { UpgradeRequiredModal } from "./upgrade-required-modal";
import { usePlanLimits, type PlanLimitsBundle } from "@/hooks/use-plan-limits";

interface UpgradeModalState {
  visible: boolean;
  featureLabel: string;
  description?: string;
  usage?: { current: number; limit: number | "unlimited" };
  recommended?: "plan_pro" | "plan_enterprise";
}

interface UpgradeModalContextValue {
  triggerUpgrade: (input: {
    featureLabel: string;
    description?: string;
    usage?: { current: number; limit: number | "unlimited" };
    recommended?: "plan_pro" | "plan_enterprise";
  }) => void;
  /** Returns true if the response was a plan-gate 402 (and the modal opened). */
  handlePlanGateResponse: (res: Response) => Promise<boolean>;
  /**
   * Inspect a thrown error. Recognizes any error whose `status === 402`
   * and `code === "PLAN_GATE_DENIED"` (or whose `details` carries those
   * fields) and opens the modal. Returns true if handled.
   */
  handlePlanGateError: (err: unknown) => boolean;
}

const UpgradeModalContext = createContext<UpgradeModalContextValue | null>(null);

export function UpgradeModalProvider({ children }: { children: ReactNode }) {
  const { bundle } = usePlanLimits();
  const [state, setState] = useState<UpgradeModalState>({
    visible: false,
    featureLabel: "",
  });

  const close = useCallback(() => {
    setState((prev) => ({ ...prev, visible: false }));
  }, []);

  const triggerUpgrade = useCallback<UpgradeModalContextValue["triggerUpgrade"]>((input) => {
    setState({
      visible: true,
      featureLabel: input.featureLabel,
      description: input.description,
      usage: input.usage,
      recommended: input.recommended,
    });
  }, []);

  const handlePlanGateResponse = useCallback<UpgradeModalContextValue["handlePlanGateResponse"]>(
    async (res) => {
      if (res.status !== 402) return false;
      let payload: PlanGateErrorBody | null = null;
      try {
        payload = (await res.clone().json()) as PlanGateErrorBody;
      } catch {
        return false;
      }
      if (!payload || payload.code !== "PLAN_GATE_DENIED") return false;
      const { featureLabel, description, usage } = describePlanGate(payload, bundle);
      triggerUpgrade({
        featureLabel,
        description,
        usage,
        recommended: payload.recommendedPlan === "plan_enterprise" ? "plan_enterprise" : "plan_pro",
      });
      return true;
    },
    [bundle, triggerUpgrade],
  );

  const handlePlanGateError = useCallback<UpgradeModalContextValue["handlePlanGateError"]>(
    (err) => {
      const payload = extractPlanGateBody(err);
      if (!payload) return false;
      const { featureLabel, description, usage } = describePlanGate(payload, bundle);
      triggerUpgrade({
        featureLabel,
        description,
        usage,
        recommended: payload.recommendedPlan === "plan_enterprise" ? "plan_enterprise" : "plan_pro",
      });
      return true;
    },
    [bundle, triggerUpgrade],
  );

  const value = useMemo<UpgradeModalContextValue>(
    () => ({ triggerUpgrade, handlePlanGateResponse, handlePlanGateError }),
    [triggerUpgrade, handlePlanGateResponse, handlePlanGateError],
  );

  return (
    <UpgradeModalContext.Provider value={value}>
      {children}
      <UpgradeRequiredModal
        visible={state.visible}
        onClose={close}
        featureLabel={state.featureLabel}
        description={state.description}
        usage={state.usage}
        bundle={bundle}
        recommended={state.recommended}
      />
    </UpgradeModalContext.Provider>
  );
}

export function useUpgradeModal(): UpgradeModalContextValue {
  const ctx = useContext(UpgradeModalContext);
  if (!ctx) {
    throw new Error("useUpgradeModal must be used inside <UpgradeModalProvider />");
  }
  return ctx;
}

interface PlanGateErrorBody {
  error: string;
  code: "PLAN_GATE_DENIED";
  featureKey: string;
  planId: string;
  limit: string | null;
  currentValue: number | null;
  recommendedPlan: string;
}

// Map raw featureKey → user-facing copy. Keys not listed fall back to the
// server-supplied `error` message.
const FEATURE_LABEL: Record<string, { label: string; description?: string }> = {
  max_organizations: {
    label: "Create more organizations",
    description: "Your plan only allows a limited number of organizations.",
  },
  max_members_per_org: {
    label: "Invite more members",
    description: "Upgrade to add more teammates to this organization.",
  },
  max_concurrent_shared_sessions: {
    label: "Share another workspace",
    description: "You've hit the cap on concurrent shared workspaces.",
  },
  max_active_skills: {
    label: "Activate more skills",
    description: "Upgrade for unlimited active skills.",
  },
  max_active_mcps: {
    label: "Activate more MCPs",
    description: "Upgrade for unlimited active MCP servers.",
  },
  max_issue_integrations: {
    label: "Connect more issue trackers",
    description: "Upgrade to link additional issue-tracker integrations.",
  },
  max_attachments_storage_gb: {
    label: "Upload more attachments",
    description: "You've reached your attachment storage cap.",
  },
  message_retention_days: {
    label: "Extend message retention",
    description: "Upgrade to keep messages longer.",
  },
  max_session_duration_minutes: {
    label: "Run longer agent sessions",
    description: "Free sessions end after a fixed time. Upgrade to lift the cap.",
  },
  hubcode_agent_enabled: {
    label: "Enable Hubcode agent",
    description: "Hubcode-curated combos require a paid plan.",
  },
  messages_enabled: {
    label: "Enable team messaging",
    description: "Org chat & messaging are not included in the Free plan.",
  },
  audit_log_enabled: {
    label: "View audit log",
    description: "Audit logs are an Enterprise feature.",
  },
  sso_enabled: {
    label: "Enable SSO / SAML",
    description: "SSO is an Enterprise feature.",
  },
};

function extractPlanGateBody(err: unknown): PlanGateErrorBody | null {
  if (!err || typeof err !== "object") return null;
  const e = err as { status?: number; code?: string; details?: unknown };
  if (e.code === "PLAN_GATE_DENIED" && e.status === 402) {
    if (e.details && typeof e.details === "object") {
      return e.details as PlanGateErrorBody;
    }
  }
  // Some callers throw the body directly.
  if ((err as PlanGateErrorBody).code === "PLAN_GATE_DENIED") {
    return err as PlanGateErrorBody;
  }
  return null;
}

function describePlanGate(
  payload: PlanGateErrorBody,
  _bundle: PlanLimitsBundle | null,
): {
  featureLabel: string;
  description?: string;
  usage?: { current: number; limit: number | "unlimited" };
} {
  const meta = FEATURE_LABEL[payload.featureKey];
  const featureLabel = meta?.label ?? payload.error ?? "Upgrade required";
  const description = meta?.description;
  let usage: { current: number; limit: number | "unlimited" } | undefined;
  if (payload.currentValue != null && payload.limit != null) {
    const limit = payload.limit === "unlimited" ? "unlimited" : Number(payload.limit);
    if (typeof limit === "string" || Number.isFinite(limit)) {
      usage = { current: payload.currentValue, limit };
    }
  }
  return { featureLabel, description, usage };
}
