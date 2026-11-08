/**
 * @vitest-environment jsdom
 */
import React, { type ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Goal, Recovery } from "@getpaseo/protocol/goal/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FIXTURE_AT, makeGoal, makeTask } from "@/goals/test-utils/goal-fixture";
import { GoalRecoverButton } from "./goal-recover-sheet";

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 0: 0, 1: 4, 1.5: 6, 2: 8, 2.5: 10, 3: 12, 4: 16, 6: 24, 8: 32 },
    borderWidth: { 0: 0, 1: 1, 2: 2 },
    borderRadius: { sm: 4, md: 6, lg: 8, full: 9999 },
    fontSize: { xs: 11, sm: 13, base: 15, code: 13 },
    fontWeight: { normal: "400", medium: "500", semibold: "600" },
    fontFamily: { mono: "monospace" },
    iconSize: { sm: 14, md: 16, lg: 24 },
    opacity: { 50: 0.5 },
    colors: {
      foreground: "#fff",
      foregroundMuted: "#aaa",
      surface0: "#000",
      surface1: "#111",
      surface2: "#222",
      surface3: "#333",
      border: "#444",
      borderAccent: "#555",
      statusWarning: "#fa0",
      statusDanger: "#f00",
      interactionHighlight: "rgba(255,255,255,0.08)",
      palette: { red: { 300: "#f87171" } },
    },
  },
}));

vi.hoisted(() => {
  (globalThis as unknown as { __DEV__: boolean }).__DEV__ = false;
});

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
  },
}));

// Keys and their values, so a test can tell which sentence shows and what it carries.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key} ${JSON.stringify(params)}` : key,
  }),
}));

vi.mock("@/constants/layout", () => ({ useIsCompactFormFactor: () => false }));

const mockFeatures = vi.hoisted(() => ({
  current: { goalRecovery: true, goalTimeBase: true } as Record<string, boolean>,
}));
vi.mock("@/runtime/host-features", () => ({
  useHostFeature: (_serverId: string, feature: string) => mockFeatures.current[feature] === true,
}));

const mockStart = vi.hoisted(() => ({ fn: vi.fn(async () => {}) }));
vi.mock("@/hooks/use-goal-decision-mutations", () => ({
  useGoalDecisionMutations: () => ({ startRecovery: mockStart.fn, isStartingRecovery: false }),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onPress,
    disabled,
    testID,
  }: {
    children: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    testID?: string;
  }) => (
    <button type="button" data-testid={testID} disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/adaptive-modal-sheet", () => ({
  AdaptiveModalSheet: ({
    header,
    children,
    footer,
    testID,
  }: {
    header: { title: string };
    children: ReactNode;
    footer: ReactNode;
    testID?: string;
  }) => (
    <section data-testid={testID}>
      <h1>{header.title}</h1>
      {children}
      {footer}
    </section>
  ),
}));

vi.mock("@/components/ui/form-field", () => ({
  Field: ({ label, children }: { label: string; children: ReactNode }) => (
    <label>
      {label}
      {children}
    </label>
  ),
  FormTextInput: ({ initialValue, testID }: { initialValue: string; testID?: string }) => (
    <textarea data-testid={testID} defaultValue={initialValue} />
  ),
}));

vi.mock("@/components/ui/segmented-control", () => ({
  SegmentedControl: ({
    options,
    value,
  }: {
    options: { value: string; testID?: string }[];
    value: string;
  }) => (
    <div>
      {options.map((option) => (
        <span key={option.value} data-testid={option.testID} data-selected={value === option.value}>
          {option.value}
        </span>
      ))}
    </div>
  ),
}));

const LEAD_REASON =
  "UV-02 still fails in updater_module.c:1301-1310. Decide whether the schema may change.";
const ENDED_AT = "2026-10-21T02:00:00.000Z";

function endedRecovery(): Recovery {
  return {
    id: "r1",
    status: "ended",
    startedAt: FIXTURE_AT,
    startedBy: "person",
    failureReason: "Acceptance criteria not met",
    outcome: "needs_person",
    reason: LEAD_REASON,
    resolvedAt: ENDED_AT,
    decision: { decision: "needs_person", reason: LEAD_REASON },
  };
}

function failedGoal(overrides: Partial<Goal> = {}): Goal {
  const base = makeGoal({ status: "failed" });
  return makeGoal({
    status: "failed",
    failedAt: ENDED_AT,
    failureReason: `Recovery needs a person: ${LEAD_REASON}`,
    tasks: [makeTask("t7", { title: "Capture", status: "failed" })],
    guidance: { goal: "Keep the old schema", tasks: { t7: "Use the v2 parser" } },
    recoveries: 1,
    recovery: endedRecovery(),
    config: base.config ? { ...base.config, limits: { goalTimeoutMinutes: 60 } } : null,
    ...overrides,
  });
}

function open(goal: Goal) {
  render(<GoalRecoverButton serverId="s1" goal={goal} events={[]} />);
  fireEvent.click(screen.getByTestId("goal-recover"));
}

afterEach(() => {
  cleanup();
  mockFeatures.current = { goalRecovery: true, goalTimeBase: true };
});

describe("GoalRecoverButton", () => {
  it("says Recover again and opens the sheet seeded with your own previous instructions", () => {
    open(failedGoal());
    expect(screen.getByTestId("goal-recover").textContent).toBe("goals.failure.recoverAgain");
    expect((screen.getByTestId("goal-recover-goal-instruction") as HTMLTextAreaElement).value).toBe(
      "Keep the old schema",
    );
    expect((screen.getByTestId("goal-recover-task-t7") as HTMLTextAreaElement).value).toBe(
      "Use the v2 parser",
    );
    expect(screen.getByTestId("goal-recover-left").textContent).toContain('"left":2');
  });

  it("shows the Lead's reason above the fields and never inside one", () => {
    open(failedGoal());
    expect(screen.getByTestId("goal-recover-lead-said").textContent).toContain(
      "goals.failure.leadSaid",
    );
    for (const field of screen.getAllByRole("textbox")) {
      expect((field as HTMLTextAreaElement).value).not.toContain("UV-02");
    }
  });

  it("starts on the time left when the limit has passed and at least 30 minutes remain", () => {
    open(failedGoal());
    expect(screen.getByTestId("goal-recover-time-remaining").dataset.selected).toBe("true");
  });

  it("starts on a fresh limit when less than 30 minutes would remain", () => {
    const goal = failedGoal();
    open({
      ...goal,
      config: goal.config ? { ...goal.config, limits: { goalTimeoutMinutes: 20 } } : null,
    });
    expect(screen.getByTestId("goal-recover-time-fresh").dataset.selected).toBe("true");
  });

  it("is disabled once the goal used every recovery, and opens nothing", () => {
    render(<GoalRecoverButton serverId="s1" goal={failedGoal({ recoveries: 3 })} events={[]} />);
    const button = screen.getByTestId("goal-recover") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(screen.queryByTestId("goal-recover-sheet")).toBeNull();
  });

  it("says the Lead can add fix tasks for a failed verification, on a host that allows it", () => {
    const verificationFailed = failedGoal({
      tasks: [makeTask("t7", { title: "Capture", status: "succeeded" })],
      criteria: [{ id: "c1", text: "UV-02 is fixed", verifiedAt: null, evidence: null }],
    });
    mockFeatures.current = { ...mockFeatures.current, goalVerificationRecovery: true };
    open(verificationFailed);
    expect(screen.getByTestId("goal-recover-verification-fix").textContent).toBe(
      "goals.failure.verificationFix",
    );
    cleanup();
    mockFeatures.current = { goalRecovery: true, goalTimeBase: true };
    open(verificationFailed);
    expect(screen.queryByTestId("goal-recover-verification-fix")).toBeNull();
  });

  it("says nothing about fix tasks when a task failed", () => {
    mockFeatures.current = { ...mockFeatures.current, goalVerificationRecovery: true };
    open(failedGoal());
    expect(screen.queryByTestId("goal-recover-verification-fix")).toBeNull();
  });
});
