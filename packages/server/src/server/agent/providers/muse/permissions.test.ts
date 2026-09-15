import { describe, expect, test } from "vitest";

import type { AgentPermissionResponse } from "../../agent-sdk-types.js";
import {
  buildMuseApprovalDecision,
  buildMuseUserInputResolution,
  mapMuseApprovalRequest,
  mapMuseUserInputRequest,
  MUSE_APPROVAL_METADATA,
  MUSE_USER_INPUT_METADATA,
  readMspErrorKind,
} from "./permissions.js";

function approvalParams(overrides: Record<string, unknown> = {}) {
  return {
    approvalId: "approval-1",
    sessionId: "session-1",
    currentRequirementId: "req-1",
    toolName: "shell",
    rawArgs: JSON.stringify({ command: "rm -rf /tmp/x" }),
    subject: {
      kind: "shell",
      stages: [{ argv: ["rm", "-rf", "/tmp/x"] }],
      workspaceRoot: "/tmp/ws",
    },
    availableChoices: [
      {
        choiceId: "allow-once",
        decision: "approved",
        label: "Allow once",
        scope: "once",
        acceptsFeedback: false,
      },
      {
        choiceId: "allow-session",
        decision: "approvedForSession",
        label: "Allow for session",
        scope: "session",
        acceptsFeedback: false,
      },
      {
        choiceId: "deny",
        decision: "denied",
        label: "Deny",
        scope: "once",
        acceptsFeedback: true,
      },
    ],
    ...overrides,
  };
}

function userInputParams(overrides: Record<string, unknown> = {}) {
  return {
    userInputId: "input-1",
    sessionId: "session-1",
    toolName: "askUser",
    questions: [
      {
        id: "q1",
        header: "Target",
        question: "Which target?",
        selection: { mode: "single" },
        options: [
          { label: "a", description: "first" },
          { label: "b" },
        ],
      },
    ],
    ...overrides,
  };
}

describe("mapMuseApprovalRequest", () => {
  test("maps a shell approval with allow/deny actions", () => {
    const mapped = mapMuseApprovalRequest(approvalParams(), "muse");

    expect(mapped?.request).toMatchObject({
      id: "approval-1",
      provider: "muse",
      name: "shell",
      kind: "tool",
      title: "Allow shell command: rm -rf /tmp/x",
      detail: { type: "shell", command: "rm -rf /tmp/x", cwd: "/tmp/ws" },
      actions: [
        { id: "allow-once", label: "Allow once", behavior: "allow", variant: "primary" },
        {
          id: "allow-session",
          label: "Allow for session",
          behavior: "allow",
          variant: "secondary",
        },
        { id: "deny", label: "Deny", behavior: "deny", variant: "danger" },
      ],
    });
    expect(mapped?.request.metadata?.["musePendingKind"]).toBe(MUSE_APPROVAL_METADATA);
    expect(mapped?.entry).toMatchObject({
      kind: "approval",
      approvalId: "approval-1",
      requirementId: "req-1",
      sessionId: "session-1",
    });
  });

  test("maps file and network subjects to rich details", () => {
    const read = mapMuseApprovalRequest(
      approvalParams({
        toolName: "readFile",
        subject: { kind: "fileAccess", path: "/tmp/ws/a.ts", access: "read" },
      }),
      "muse",
    );
    expect(read?.request.detail).toEqual({ type: "read", filePath: "/tmp/ws/a.ts" });

    const write = mapMuseApprovalRequest(
      approvalParams({
        toolName: "writeFile",
        subject: { kind: "fileAccess", path: "/tmp/ws/a.ts", access: "write" },
      }),
      "muse",
    );
    expect(write?.request.detail).toEqual({ type: "write", filePath: "/tmp/ws/a.ts" });

    const network = mapMuseApprovalRequest(
      approvalParams({
        toolName: "fetch",
        subject: { kind: "network", host: "example.com", protocol: "https", port: 443 },
      }),
      "muse",
    );
    expect(network?.request.detail).toEqual({
      type: "fetch",
      url: "https://example.com:443",
    });
  });

  test("falls back to plain text for unknown tool subjects", () => {
    const parsed = mapMuseApprovalRequest(
      approvalParams({
        toolName: "custom",
        subject: { kind: "tool" },
        rawArgs: JSON.stringify({ a: 1 }),
      }),
      "muse",
    );
    expect(parsed?.request.detail).toEqual({
      type: "unknown",
      input: { a: 1 },
      output: null,
    });

    const raw = mapMuseApprovalRequest(
      approvalParams({
        toolName: "custom",
        subject: { kind: "tool" },
        rawArgs: "not json",
      }),
      "muse",
    );
    expect(raw?.request.detail).toEqual({
      type: "plain_text",
      label: "custom",
      text: "not json",
    });
  });

  test("appends protection flags to the description", () => {
    const mapped = mapMuseApprovalRequest(
      approvalParams({ protectedWrite: true, judgeEscalated: true }),
      "muse",
    );
    expect(mapped?.request.description).toBe("Protected write. Escalated for review.");
  });

  test("rejects approvals without identity, subject, requirement, or choices", () => {
    expect(mapMuseApprovalRequest(approvalParams({ approvalId: 1 }), "muse")).toBeNull();
    expect(mapMuseApprovalRequest(approvalParams({ sessionId: null }), "muse")).toBeNull();
    expect(mapMuseApprovalRequest(approvalParams({ subject: "shell" }), "muse")).toBeNull();
    const { currentRequirementId: _dropped, ...withoutRequirement } = approvalParams();
    expect(mapMuseApprovalRequest(withoutRequirement, "muse")).toBeNull();
    expect(mapMuseApprovalRequest(approvalParams({ availableChoices: [] }), "muse")).toBeNull();
    expect(
      mapMuseApprovalRequest(approvalParams({ availableChoices: [{ choiceId: "x" }] }), "muse"),
    ).toBeNull();
  });
});

describe("buildMuseApprovalDecision", () => {
  test("resolves an explicit choice and rejects unknown ids", () => {
    const mapped = mapMuseApprovalRequest(approvalParams(), "muse");
    expect(mapped).not.toBeNull();
    if (!mapped) return;

    expect(
      buildMuseApprovalDecision(mapped.entry, {
        behavior: "allow",
        selectedActionId: "allow-session",
      } satisfies AgentPermissionResponse),
    ).toEqual({ choiceId: "allow-session" });
    expect(() =>
      buildMuseApprovalDecision(mapped.entry, {
        behavior: "allow",
        selectedActionId: "nope",
      } satisfies AgentPermissionResponse),
    ).toThrow("Unknown Muse approval choice: nope");
  });

  test("prefers the once-scoped allow choice without a selection", () => {
    const mapped = mapMuseApprovalRequest(approvalParams(), "muse");
    expect(mapped).not.toBeNull();
    if (!mapped) return;

    expect(
      buildMuseApprovalDecision(mapped.entry, {
        behavior: "allow",
      } satisfies AgentPermissionResponse),
    ).toEqual({ choiceId: "allow-once" });
    expect(
      buildMuseApprovalDecision(mapped.entry, {
        behavior: "deny",
      } satisfies AgentPermissionResponse),
    ).toEqual({ choiceId: "deny" });
  });

  test("attaches deny feedback only when the choice accepts it", () => {
    const mapped = mapMuseApprovalRequest(approvalParams(), "muse");
    expect(mapped).not.toBeNull();
    if (!mapped) return;

    expect(
      buildMuseApprovalDecision(mapped.entry, {
        behavior: "deny",
        message: "too risky",
      } satisfies AgentPermissionResponse),
    ).toEqual({ choiceId: "deny", feedback: "too risky" });
    expect(
      buildMuseApprovalDecision(mapped.entry, {
        behavior: "deny",
        selectedActionId: "deny",
        message: "too risky",
      } satisfies AgentPermissionResponse),
    ).toEqual({ choiceId: "deny", feedback: "too risky" });
    expect(
      buildMuseApprovalDecision(mapped.entry, {
        behavior: "deny",
        selectedActionId: "allow-session",
        message: "ignored",
      } satisfies AgentPermissionResponse),
    ).toEqual({ choiceId: "allow-session" });
  });

  test("throws when no choice matches the behavior", () => {
    const mapped = mapMuseApprovalRequest(
      approvalParams({
        availableChoices: [
          {
            choiceId: "deny",
            decision: "denied",
            label: "Deny",
            scope: "once",
            acceptsFeedback: false,
          },
        ],
      }),
      "muse",
    );
    expect(mapped).not.toBeNull();
    if (!mapped) return;

    expect(() =>
      buildMuseApprovalDecision(mapped.entry, {
        behavior: "allow",
      } satisfies AgentPermissionResponse),
    ).toThrow("Muse approval offers no allow choice");
  });
});

describe("mapMuseUserInputRequest", () => {
  test("maps questions with options and selection modes", () => {
    const mapped = mapMuseUserInputRequest(
      userInputParams({
        questions: [
          {
            id: "q1",
            header: "Target",
            question: "Which target?",
            selection: { mode: "single" },
            options: [{ label: "a" }],
          },
          {
            id: "q2",
            header: "Extras",
            question: "Which extras?",
            selection: { mode: "multiple" },
            options: [{ label: "x" }, { label: "y" }],
          },
        ],
      }),
      "muse",
    );

    expect(mapped?.request).toMatchObject({
      id: "input-1",
      provider: "muse",
      name: "askUser",
      kind: "question",
      title: "askUser: 2 questions",
      input: {
        questions: [
          {
            question: "Which target?",
            header: "Target",
            options: [{ label: "a" }],
            multiSelect: false,
          },
          {
            question: "Which extras?",
            header: "Extras",
            options: [{ label: "x" }, { label: "y" }],
            multiSelect: true,
          },
        ],
      },
    });
    expect(mapped?.request.metadata?.["musePendingKind"]).toBe(MUSE_USER_INPUT_METADATA);
    expect(mapped?.entry).toMatchObject({
      kind: "userInput",
      userInputId: "input-1",
      sessionId: "session-1",
    });
  });

  test("uses the question text as the title for a single question", () => {
    const mapped = mapMuseUserInputRequest(userInputParams(), "muse");
    expect(mapped?.request.title).toBe("Which target?");
  });

  test("rejects requests without identity or questions", () => {
    expect(mapMuseUserInputRequest(userInputParams({ userInputId: 1 }), "muse")).toBeNull();
    expect(mapMuseUserInputRequest(userInputParams({ questions: [] }), "muse")).toBeNull();
    expect(
      mapMuseUserInputRequest(userInputParams({ questions: [{ id: "q1" }] }), "muse"),
    ).toBeNull();
  });
});

describe("buildMuseUserInputResolution", () => {
  test("cancels with the deny reason", () => {
    const mapped = mapMuseUserInputRequest(userInputParams(), "muse");
    expect(mapped).not.toBeNull();
    if (!mapped) return;

    expect(
      buildMuseUserInputResolution(mapped.entry, {
        behavior: "deny",
        message: "stop asking",
      } satisfies AgentPermissionResponse),
    ).toEqual({ cancel: true, reason: "stop asking" });
  });

  test("reads single-select answers from updated input", () => {
    const mapped = mapMuseUserInputRequest(userInputParams(), "muse");
    expect(mapped).not.toBeNull();
    if (!mapped) return;

    expect(
      buildMuseUserInputResolution(mapped.entry, {
        behavior: "allow",
        updatedInput: { answers: { Target: "b" } },
      } satisfies AgentPermissionResponse),
    ).toEqual({ cancel: false, answers: [{ questionId: "q1", selectedLabel: "b" }] });
  });

  test("splits multi-select answers on commas", () => {
    const mapped = mapMuseUserInputRequest(
      userInputParams({
        questions: [
          {
            id: "q2",
            header: "Extras",
            question: "Which extras?",
            selection: { mode: "multiple" },
            options: [{ label: "x" }, { label: "y" }],
          },
        ],
      }),
      "muse",
    );
    expect(mapped).not.toBeNull();
    if (!mapped) return;

    expect(
      buildMuseUserInputResolution(mapped.entry, {
        behavior: "allow",
        updatedInput: { answers: { Extras: "x, y, " } },
      } satisfies AgentPermissionResponse),
    ).toEqual({ cancel: false, answers: [{ questionId: "q2", selectedLabels: ["x", "y"] }] });
  });

  test("truncates free-text answers to 500 chars", () => {
    const mapped = mapMuseUserInputRequest(
      userInputParams({
        questions: [
          {
            id: "q3",
            header: "Notes",
            question: "Anything else?",
            selection: { mode: "single" },
            options: [],
          },
        ],
      }),
      "muse",
    );
    expect(mapped).not.toBeNull();
    if (!mapped) return;

    const resolution = buildMuseUserInputResolution(mapped.entry, {
      behavior: "allow",
      updatedInput: { answers: { Notes: "n".repeat(600) } },
    } satisfies AgentPermissionResponse);
    expect(resolution).toEqual({
      cancel: false,
      answers: [{ questionId: "q3", freeText: "n".repeat(500) }],
    });
  });
});

describe("readMspErrorKind", () => {
  test("reads the kind field from error objects", () => {
    expect(readMspErrorKind({ kind: "commandRejected" })).toBe("commandRejected");
    expect(readMspErrorKind({ kind: 42 })).toBeUndefined();
    expect(readMspErrorKind(new Error("boom"))).toBeUndefined();
    expect(readMspErrorKind(null)).toBeUndefined();
  });
});
