import type { TFunction } from "i18next";
import { create } from "zustand";
import type {
  BrowserActivityEvent,
  BrowserActivityStep,
  BrowserHandoff,
} from "@getpaseo/protocol/browser-activity/rpc-schemas";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";

function activityKey(serverId: string, workspaceId: string, browserId: string): string {
  return `${serverId}\u0000${workspaceId}\u0000${browserId}`;
}

function handoffKey(serverId: string, handoffId: string): string {
  return `${serverId}\u0000${handoffId}`;
}

interface BrowserActivityState {
  byBrowser: Record<string, BrowserActivityEvent>;
  /** Every known handoff by id, so a chat card can show how its own handoff ended. */
  handoffs: Record<string, BrowserHandoff>;
  activeHandoffByBrowser: Record<string, BrowserHandoff>;
  apply: (serverId: string, event: BrowserActivityEvent) => void;
  applyHandoff: (serverId: string, handoff: BrowserHandoff) => void;
  /** A new subscription re-sends live runs and handoffs; drop the ones that ended while disconnected. */
  resetServer: (serverId: string) => void;
  dismiss: (serverId: string, event: BrowserActivityEvent) => void;
}

function withoutServerEntries<T>(
  entries: Record<string, T>,
  serverId: string,
  keep: (entry: T) => boolean,
): Record<string, T> {
  const kept = Object.entries(entries).filter(
    ([key, entry]) => !key.startsWith(`${serverId}\u0000`) || keep(entry),
  );
  return Object.fromEntries(kept);
}

export const useBrowserActivityStore = create<BrowserActivityState>((set) => ({
  byBrowser: {},
  handoffs: {},
  activeHandoffByBrowser: {},
  apply: (serverId, event) =>
    set((state) => ({
      byBrowser: {
        ...state.byBrowser,
        [activityKey(serverId, event.workspaceId, event.browserId)]: event,
      },
    })),
  applyHandoff: (serverId, handoff) =>
    set((state) => {
      const browserKey = activityKey(serverId, handoff.workspaceId, handoff.browserId);
      const activeHandoffByBrowser = { ...state.activeHandoffByBrowser };
      if (handoff.status === "active") {
        activeHandoffByBrowser[browserKey] = handoff;
      } else if (activeHandoffByBrowser[browserKey]?.handoffId === handoff.handoffId) {
        delete activeHandoffByBrowser[browserKey];
      }
      return {
        handoffs: { ...state.handoffs, [handoffKey(serverId, handoff.handoffId)]: handoff },
        activeHandoffByBrowser,
      };
    }),
  resetServer: (serverId) =>
    set((state) => ({
      byBrowser: withoutServerEntries(
        state.byBrowser,
        serverId,
        (event) => event.phase === "finished",
      ),
      handoffs: withoutServerEntries(
        state.handoffs,
        serverId,
        (handoff) => handoff.status !== "active",
      ),
      activeHandoffByBrowser: withoutServerEntries(
        state.activeHandoffByBrowser,
        serverId,
        () => false,
      ),
    })),
  dismiss: (serverId, event) =>
    set((state) => {
      const key = activityKey(serverId, event.workspaceId, event.browserId);
      if (state.byBrowser[key]?.runId !== event.runId) return state;
      const { [key]: _dismissed, ...byBrowser } = state.byBrowser;
      return { byBrowser };
    }),
}));

export function useBrowserActivity(
  serverId: string,
  workspaceId: string,
  browserId: string | null | undefined,
): BrowserActivityEvent | null {
  return useBrowserActivityStore((state) =>
    browserId ? (state.byBrowser[activityKey(serverId, workspaceId, browserId)] ?? null) : null,
  );
}

export function useBrowserHandoff(
  serverId: string,
  handoffId: string | null,
): BrowserHandoff | null {
  return useBrowserActivityStore((state) =>
    handoffId ? (state.handoffs[handoffKey(serverId, handoffId)] ?? null) : null,
  );
}

export function useActiveBrowserHandoff(
  serverId: string,
  workspaceId: string,
  browserId: string | null | undefined,
): BrowserHandoff | null {
  return useBrowserActivityStore((state) =>
    browserId
      ? (state.activeHandoffByBrowser[activityKey(serverId, workspaceId, browserId)] ?? null)
      : null,
  );
}

export function isBrowserRunActive(event: BrowserActivityEvent | null): boolean {
  return event !== null && event.phase !== "finished";
}

/** Input stays with the run until it pauses at a safe boundary. */
export function isBrowserRunLocked(event: BrowserActivityEvent | null): boolean {
  return isBrowserRunActive(event) && event?.phase !== "paused";
}

export function browserActivityStatusBucket(
  event: BrowserActivityEvent | null,
): SidebarStateBucket | null {
  if (!event) return null;
  if (event.phase === "paused") return "needs_input";
  if (event.phase !== "finished") return "running";
  return event.result?.status === "failed" ? "failed" : null;
}

/** Operation names are protocol tokens, like command names, and stay untranslated. */
export function describeBrowserActivityStep(step: BrowserActivityStep): string {
  return [
    step.operation.toLowerCase(),
    step.target ? `${step.target.role} “${step.target.name}”` : null,
    step.valueSlot ? `← ${step.valueSlot}` : null,
    step.detail || null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

export function formatBrowserActivityConfidence(
  step: BrowserActivityStep | undefined,
): string | null {
  const values = [step?.confidence, step?.targetConfidence].filter(
    (value): value is number => value !== undefined,
  );
  return values.length > 0 ? `${Math.round(Math.min(...values) * 100)} %` : null;
}

export function formatBrowserActivityStep(event: BrowserActivityEvent, t: TFunction): string {
  return event.totalSteps
    ? t("workspace.browser.activity.stepOf", { step: event.step, total: event.totalSteps })
    : t("workspace.browser.activity.step", { step: event.step });
}

/**
 * The polite live-region text. Observing and deciding read as one state so a Jev step
 * announces twice at most: checking the page, then the chosen action.
 */
export function summarizeBrowserActivity(event: BrowserActivityEvent, t: TFunction): string {
  if (event.phase === "finished") {
    return event.result?.status === "passed"
      ? t("workspace.browser.activity.passed")
      : t("workspace.browser.activity.failed", { message: event.result?.message ?? "" });
  }
  if (event.phase === "paused") return t("workspace.browser.activity.paused");
  if (event.pauseRequested) return t("workspace.browser.activity.pausing");
  const current = event.action
    ? describeBrowserActivityStep(event.action)
    : t("workspace.browser.activity.checkingPage");
  return `${formatBrowserActivityStep(event, t)} · ${current}`;
}

/** Jev picks its next step only after observing again, so it is never guessed here. */
export function describeNextBrowserActivityStep(
  event: BrowserActivityEvent,
  t: TFunction,
): string | null {
  if (event.next) return describeBrowserActivityStep(event.next);
  if (event.kind === "goal" && isBrowserRunActive(event)) {
    return t("workspace.browser.activity.recheckPage");
  }
  return null;
}
