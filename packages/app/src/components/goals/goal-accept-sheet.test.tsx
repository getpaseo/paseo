/**
 * @vitest-environment jsdom
 */
import React, { type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MAX_ACCEPT_NOTE_CHARS, type Goal } from "@getpaseo/protocol/goal/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FIXTURE_AT, makeGoal, makeTask } from "@/goals/test-utils/goal-fixture";
import { GoalAcceptButton } from "./goal-accept-sheet";

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

const mockAccept = vi.hoisted(() => ({
  fn: vi.fn(
    async (_input: { goalId: string; criterionIds: string[]; note: string; eventId?: string }) =>
      null,
  ),
  /** What the hook reports as in flight. */
  pending: false,
}));
vi.mock("@/hooks/use-goal-decision-mutations", () => ({
  useGoalDecisionMutations: () => ({
    acceptGoal: mockAccept.fn,
    isAcceptingGoal: mockAccept.pending,
  }),
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
    <button type="button" data-testid={testID} aria-disabled={disabled} onClick={onPress}>
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

// The note field's change handler, so a test can type into the sheet.
const mockNote = vi.hoisted(() => ({ change: null as ((text: string) => void) | null }));
vi.mock("@/components/ui/form-field", () => ({
  Field: ({
    label,
    error,
    children,
  }: {
    label: string;
    error?: string | null;
    children: ReactNode;
  }) => (
    <label>
      {label}
      {children}
      {error ? <span data-testid="field-error">{error}</span> : null}
    </label>
  ),
  FormTextInput: ({
    initialValue,
    testID,
    onChangeText,
  }: {
    initialValue: string;
    testID?: string;
    onChangeText?: (text: string) => void;
  }) => {
    mockNote.change = onChangeText ?? null;
    return <textarea data-testid={testID} defaultValue={initialValue} />;
  },
}));

const criteria: Goal["criteria"] = [
  { id: "c1", text: "UV-02 is fixed", verifiedAt: null, evidence: null },
  { id: "c2", text: "Docs updated", verifiedAt: FIXTURE_AT, evidence: "ok" },
];

function failedGoal(overrides: Partial<Goal> = {}): Goal {
  return makeGoal({
    status: "failed",
    failedAt: FIXTURE_AT,
    failureReason: "Acceptance criteria not met: c1",
    tasks: [makeTask("t1", { status: "succeeded", captured: true })],
    criteria,
    ...overrides,
  });
}

function open(goal: Goal) {
  render(<GoalAcceptButton serverId="s1" goal={goal} />);
  fireEvent.click(screen.getByTestId("goal-accept"));
}

function typeNote(text: string) {
  act(() => mockNote.change?.(text));
}

afterEach(() => {
  cleanup();
  mockAccept.fn.mockReset();
  mockAccept.pending = false;
});

describe("GoalAcceptButton", () => {
  it("lists the unverified criteria under Not met when verification judged them", () => {
    open(failedGoal());
    expect(screen.getByTestId("goal-accept-group-notMet").textContent).toContain("UV-02 is fixed");
    expect(screen.getByTestId("goal-accept-group-notMet").textContent).not.toContain(
      "Docs updated",
    );
    expect(screen.queryByTestId("goal-accept-group-neverChecked")).toBeNull();
  });

  it("lists them under Never checked when the goal failed before verification answered", () => {
    open(failedGoal({ failureReason: "Goal timed out" }));
    expect(screen.getByTestId("goal-accept-group-neverChecked").textContent).toContain(
      "UV-02 is fixed",
    );
    expect(screen.queryByTestId("goal-accept-group-notMet")).toBeNull();
  });

  it("needs a note before Confirm, and says when the note is too long", () => {
    open(failedGoal());
    const confirm = screen.getByTestId("goal-accept-confirm");
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    typeNote("   ");
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    expect(screen.queryByTestId("field-error")).toBeNull();
    typeNote("x".repeat(MAX_ACCEPT_NOTE_CHARS + 1));
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByTestId("field-error").textContent).toBe(
      `goals.accept.noteTooLong {"max":${MAX_ACCEPT_NOTE_CHARS}}`,
    );
    typeNote("  Good enough for the release  ");
    expect(confirm.getAttribute("aria-disabled")).toBe("false");
  });

  it("sends every unverified criterion with the trimmed note", () => {
    open(failedGoal());
    typeNote("  Good enough for the release  ");
    fireEvent.click(screen.getByTestId("goal-accept-confirm"));
    expect(mockAccept.fn).toHaveBeenCalledWith({
      goalId: "goal-1",
      criterionIds: ["c1"],
      note: "Good enough for the release",
      eventId: expect.any(String),
    });
  });

  it("sends one event id per open, the same on a retry, a new one on the next open", async () => {
    mockAccept.fn.mockRejectedValueOnce(new Error("timed out"));
    open(failedGoal());
    typeNote("Good enough");
    fireEvent.click(screen.getByTestId("goal-accept-confirm"));
    await screen.findByTestId("goal-accept-error");
    fireEvent.click(screen.getByTestId("goal-accept-confirm"));
    const [first, retry] = mockAccept.fn.mock.calls.map(([input]) => input.eventId);
    expect(first).toBeTruthy();
    expect(retry).toBe(first);
    cleanup();
    open(failedGoal());
    typeNote("Good enough");
    fireEvent.click(screen.getByTestId("goal-accept-confirm"));
    expect(mockAccept.fn.mock.calls[2]?.[0].eventId).not.toBe(first);
  });

  it("sends nothing while an accept is already in flight", () => {
    open(failedGoal());
    typeNote("Good enough");
    mockAccept.pending = true;
    typeNote("Good enough!");
    fireEvent.click(screen.getByTestId("goal-accept-confirm"));
    expect(mockAccept.fn).not.toHaveBeenCalled();
  });

  it("explains that nothing is waived when every criterion was verified", () => {
    open(
      failedGoal({
        criteria: [{ id: "c1", text: "UV-02 is fixed", verifiedAt: FIXTURE_AT, evidence: "ok" }],
      }),
    );
    expect(screen.getByTestId("goal-accept-explain").textContent).toBe(
      "goals.accept.explainNothingWaived",
    );
    expect(screen.queryByTestId("goal-accept-group-notMet")).toBeNull();
    expect(screen.queryByTestId("goal-accept-group-neverChecked")).toBeNull();
  });

  it("shows the host's error when it refuses", async () => {
    mockAccept.fn.mockRejectedValueOnce(new Error("recovery r2 is still deciding"));
    open(failedGoal());
    typeNote("Good enough");
    fireEvent.click(screen.getByTestId("goal-accept-confirm"));
    expect((await screen.findByTestId("goal-accept-error")).textContent).toBe(
      "recovery r2 is still deciding",
    );
  });
});
