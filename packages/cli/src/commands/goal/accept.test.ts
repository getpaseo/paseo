import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Goal } from "@getpaseo/protocol/goal/types";
import {
  confirmGoalAccept,
  describeWaiver,
  requireAcceptNote,
  runAcceptCommand,
} from "./accept.js";
import { createGoalCommand } from "./index.js";
import { connectGoalClient, goalStatusLabel } from "./shared.js";

vi.mock("./shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared.js")>()),
  connectGoalClient: vi.fn(),
}));

const AT = "2026-10-27T09:00:00.000Z";

/** A goal whose one task succeeded and was merged; c2 was verified, c1 not. */
function unmetGoal(overrides: Record<string, unknown> = {}): Goal {
  return {
    id: "g1",
    title: "Ship",
    objective: "obj",
    status: "failed",
    config: { cwd: "/repo", leadProvider: "claude", defaultProvider: "codex" },
    leadAgentId: null,
    leadWorkspaceId: null,
    tasks: [
      {
        id: "a",
        title: "a",
        description: "",
        kind: "implement",
        dependsOn: [],
        status: "succeeded",
        attempts: 1,
        summary: "ok",
        error: null,
        captured: true,
      },
    ],
    runs: [],
    changeSets: [{ id: "cs-a-a1", taskId: "a", status: "integrated" }],
    integration: null,
    criteria: [
      { id: "c1", text: "works", verifiedAt: null, evidence: null },
      { id: "c2", text: "fast", verifiedAt: AT, evidence: "ok" },
    ],
    lastSeq: 20,
    failureReason: "Acceptance criteria not met: works (500)",
    failedAt: AT,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  } as unknown as Goal;
}

interface FakeAcceptClient {
  sent: Record<string, unknown>[];
}

function fakeClient(options: {
  goal?: Goal;
  refusal?: string;
  feature?: boolean;
}): FakeAcceptClient {
  const fake: FakeAcceptClient = { sent: [] };
  vi.mocked(connectGoalClient).mockClear();
  vi.mocked(connectGoalClient).mockResolvedValue({
    supportsGoalAccept: () => options.feature ?? true,
    goalInspect: async () => ({ goal: options.goal ?? unmetGoal(), events: [], error: null }),
    goalOutcomeAccept: async (request: Record<string, unknown>) => {
      fake.sent.push(request);
      if (options.refusal) return { goal: null, error: options.refusal };
      const goal = unmetGoal();
      return {
        goal: {
          ...goal,
          status: "completed",
          failureReason: null,
          accepted: { at: AT, note: request.note, from: goal.failureReason, client: "cli" },
          criteria: [
            { ...goal.criteria[0], waived: { at: AT, note: request.note } },
            ...goal.criteria.slice(1),
          ],
        },
        error: null,
      };
    },
    close: async () => {},
  } as never);
  return fake;
}

describe("goal accept", () => {
  beforeEach(() => vi.stubEnv("PASEO_AGENT_ID", ""));
  afterEach(() => vi.unstubAllEnvs());

  test("the command is registered with --note and --yes", () => {
    const accept = createGoalCommand().commands.find((c) => c.name() === "accept");
    const flags = accept?.options.map((o) => o.long);
    expect(flags).toEqual(expect.arrayContaining(["--note", "--yes"]));
    expect(accept?.description()).toContain("Refused when PASEO_AGENT_ID is set");
  });

  test("a note is required, not empty and bounded", () => {
    expect(() => requireAcceptNote(undefined)).toThrow("--note is required");
    expect(() => requireAcceptNote("   ")).toThrow("--note must not be empty");
    expect(() => requireAcceptNote("x".repeat(2001))).toThrow("longer than 2000 characters");
    expect(requireAcceptNote("  ok  ")).toBe("ok");
  });

  test("the summary says which criteria were not met and which were never checked", () => {
    const goal = unmetGoal();
    const c1 = goal.criteria.slice(0, 1);
    expect(describeWaiver(goal, { notMet: c1, neverChecked: [] })).toBe(
      [
        "Accept goal g1 as is: it becomes completed with these criteria waived. This cannot be undone.",
        "Not met:",
        "  - c1: works",
      ].join("\n"),
    );
    expect(describeWaiver(goal, { notMet: [], neverChecked: c1 })).toContain(
      "Never checked:\n  - c1: works",
    );
  });

  test("asks first; without a terminal or with structured output it needs --yes", async () => {
    const ask = vi.fn(async () => true);
    expect(
      await confirmGoalAccept(
        "s",
        { yes: true },
        { interactive: false, structured: true, confirm: ask },
      ),
    ).toBe(true);
    await expect(
      confirmGoalAccept("s", {}, { interactive: false, structured: false, confirm: ask }),
    ).rejects.toThrow("Confirmation required; rerun with --yes.");
    await expect(
      confirmGoalAccept("s", {}, { interactive: true, structured: true, confirm: ask }),
    ).rejects.toThrow("Confirmation required");
    expect(ask).not.toHaveBeenCalled();
    expect(
      await confirmGoalAccept("s", {}, { interactive: true, structured: false, confirm: ask }),
    ).toBe(true);
    expect(ask).toHaveBeenCalledWith("s\nAccept? [y/N] ");
  });

  test("accepts with every unverified criterion and prints what was waived", async () => {
    const client = fakeClient({});
    const result = await runAcceptCommand(
      "g1",
      { note: "  UV-02 ships later ", yes: true } as never,
      {} as never,
    );
    expect(client.sent).toEqual([
      {
        goalId: "g1",
        criterionIds: ["c1"],
        note: "UV-02 ships later",
        client: "cli",
        eventId: expect.any(String),
      },
    ]);
    expect(result.data).toEqual({
      id: "g1",
      status: "completed",
      waived: ["c1"],
      note: "UV-02 ships later",
    });
  });

  test("is refused in an agent's shell before connecting", async () => {
    vi.stubEnv("PASEO_AGENT_ID", "agent-7");
    fakeClient({});
    await expect(
      runAcceptCommand("g1", { note: "x", yes: true } as never, {} as never),
    ).rejects.toMatchObject({
      code: "GOAL_PERSON_ONLY",
      message: expect.stringContaining("paseo goal accept is for a person"),
    });
    expect(connectGoalClient).not.toHaveBeenCalled();
  });

  test("a missing note is refused before connecting", async () => {
    fakeClient({});
    await expect(runAcceptCommand("g1", { yes: true } as never, {} as never)).rejects.toMatchObject(
      {
        code: "GOAL_ACCEPT_FAILED",
        message: expect.stringContaining("--note is required"),
      },
    );
    expect(connectGoalClient).not.toHaveBeenCalled();
  });

  test("a goal with work not done, a host without the feature, or a daemon refusal fail with nothing sent or an error", async () => {
    const notDone = fakeClient({
      goal: unmetGoal({
        changeSets: [
          { id: "cs-a-a1", taskId: "a", status: "rejected", rejectionReason: "rework_failed" },
        ],
      }),
    });
    await expect(
      runAcceptCommand("g1", { note: "x", yes: true } as never, {} as never),
    ).rejects.toMatchObject({
      code: "GOAL_ACCEPT_FAILED",
      message: expect.stringContaining("change sets not merged: cs-a-a1"),
    });
    expect(notDone.sent).toEqual([]);

    const old = fakeClient({ feature: false });
    await expect(
      runAcceptCommand("g1", { note: "x", yes: true } as never, {} as never),
    ).rejects.toMatchObject({ message: expect.stringContaining("Update the host") });
    expect(old.sent).toEqual([]);

    fakeClient({ refusal: "goal.accepted: recovery rec-9 is still deciding; cancel it first" });
    await expect(
      runAcceptCommand("g1", { note: "x", yes: true } as never, {} as never),
    ).rejects.toMatchObject({
      code: "GOAL_ACCEPT_FAILED",
      message:
        "Failed to accept goal: goal.accepted: recovery rec-9 is still deciding; cancel it first",
    });
  });

  test("without --yes and no terminal it lists the waiver and asks for --yes", async () => {
    const client = fakeClient({});
    await expect(
      runAcceptCommand("g1", { note: "x", json: true } as never, {} as never),
    ).rejects.toMatchObject({
      message: expect.stringContaining("Not met:\n  - c1: works"),
    });
    expect(client.sent).toEqual([]);
  });

  test("goal ls shows an accepted goal as completed with its waived count", () => {
    const goal = unmetGoal({
      status: "completed",
      accepted: { at: AT, note: "x", from: "y", client: "cli" },
      criteria: [
        {
          id: "c1",
          text: "works",
          verifiedAt: null,
          evidence: null,
          waived: { at: AT, note: "x" },
        },
      ],
    });
    expect(goalStatusLabel(goal)).toBe("completed · 1 waived");
    expect(goalStatusLabel(unmetGoal({ status: "completed" }))).toBe("completed");
    // Accepted with nothing to waive: plain completed.
    const nothingWaived = unmetGoal({
      status: "completed",
      accepted: { at: AT, note: "x", from: "y", client: "cli" },
    });
    expect(goalStatusLabel(nothingWaived)).toBe("completed");
    expect(goalStatusLabel({ ...goal, acknowledgedAt: AT })).toBe(
      "completed · 1 waived (acknowledged)",
    );
  });
});
