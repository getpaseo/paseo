import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type {
  TypeSafeDecisionRequest,
  TypeSafeDecisionSource,
} from "../browser-tools/jev-client.js";
import {
  candidateSentences,
  classifyHandoffText,
  HandoffClassifier,
  handoffBackfillCandidates,
  type WorkspaceHandoff,
} from "./handoff-classifier.js";

function scripted(kind: string, need?: string, confidence = 0.9): TypeSafeDecisionSource {
  return {
    decide: vi.fn(async (request: TypeSafeDecisionRequest) => {
      const answer = (choice: string, keys: string[]) => ({
        choice,
        confidence,
        probabilities: Object.fromEntries(
          keys.map((key) => [key, key === choice ? 1 - 0.05 * (keys.length - 1) : 0.05]),
        ),
      });
      const needKeys = Object.keys(
        (request.questions.need as { criteria?: Record<string, unknown> } | undefined)?.criteria ??
          {},
      );
      return {
        model: "jev-test",
        latencyMs: 1,
        answers: {
          kind: answer(kind, ["question", "action", "aborted", "report"]),
          ...(need ? { need: answer(need, needKeys) } : {}),
        },
      };
    }),
  };
}

const REPLY =
  "## Stand\n- **Daemon** läuft auf `8a0950997`.\n- APK ist installiert.\n\nSoll ich den Mac jetzt neu starten oder wartest du bis heute Abend?";

describe("candidateSentences", () => {
  it("returns plain closing sentences without Markdown marks", () => {
    expect(candidateSentences(REPLY)).toEqual([
      "Daemon läuft auf 8a0950997.",
      "APK ist installiert.",
      "Soll ich den Mac jetzt neu starten oder wartest du bis heute Abend?",
    ]);
  });
});

describe("classifyHandoffText", () => {
  it("returns the kind and the agent's own sentence of what it needs", async () => {
    await expect(
      classifyHandoffText({
        decisionSource: scripted("question", "s2"),
        text: REPLY,
        minConfidence: 0.5,
      }),
    ).resolves.toEqual({
      kind: "question",
      need: "Soll ich den Mac jetzt neu starten oder wartest du bis heute Abend?",
    });
  });

  it("drops the sentence for a plain report and marks an unsure verdict as unsure", async () => {
    await expect(
      classifyHandoffText({
        decisionSource: scripted("report", "s0"),
        text: REPLY,
        minConfidence: 0.5,
      }),
    ).resolves.toEqual({ kind: "report", need: null });
    await expect(
      classifyHandoffText({
        decisionSource: scripted("report", "s2", 0.3),
        text: REPLY,
        minConfidence: 0.5,
      }),
    ).resolves.toMatchObject({ kind: "unsure" });
  });
});

describe("HandoffClassifier", () => {
  function classifier(labels: Record<string, string>, source = scripted("action", "s1")) {
    const saved: Array<{ workspaceId: string; handoff: WorkspaceHandoff }> = [];
    const instance = new HandoffClassifier({
      isEnabled: () => true,
      decisionSource: () => source,
      minConfidence: () => 0.5,
      resolveAgent: (id) => ({ id, cwd: "/repo", workspaceId: "wks", labels }),
      readLastReply: async () => REPLY,
      save: async (workspaceId, handoff) => {
        saved.push({ workspaceId, handoff });
      },
      logger: pino({ level: "silent" }),
      now: () => new Date("2026-09-30T12:00:00.000Z"),
    });
    return { instance, saved, source };
  }

  it("sorts a person-facing turn and saves it on the workspace", async () => {
    const { instance, saved } = classifier({ "paseo.origin": "paperclip:Boss" });
    instance.observe({ id: "boss" }, { type: "turn_completed", provider: "codex" });
    await vi.waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toEqual({
      workspaceId: "wks",
      handoff: {
        agentId: "boss",
        kind: "action",
        need: "APK ist installiert.",
        at: "2026-09-30T12:00:00.000Z",
      },
    });
  });

  it("never asks Jev about Paperclip workers or schedules, and skips canceled turns", async () => {
    for (const origin of ["paperclip:Dev", "schedule:21bb6e3a", "systemd:g4-watch.service"]) {
      const { instance, saved, source } = classifier({ "paseo.origin": origin });
      instance.observe({ id: "worker" }, { type: "turn_completed", provider: "codex" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(saved).toEqual([]);
      expect(source.decide).not.toHaveBeenCalled();
    }
    const { instance, saved } = classifier({ "paseo.origin": "user" });
    instance.observe({ id: "me" }, { type: "turn_canceled", provider: "claude", reason: "stop" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(saved).toEqual([]);
  });

  it("marks a failed turn aborted with its error, without asking Jev", async () => {
    const { instance, saved, source } = classifier({ "paseo.origin": "user" });
    instance.observe(
      { id: "me" },
      { type: "turn_failed", provider: "claude", error: "Session limit reached" },
    );
    await vi.waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]?.handoff).toMatchObject({ kind: "aborted", need: "Session limit reached" });
    expect(source.decide).not.toHaveBeenCalled();
  });
});

describe("handoffBackfillCandidates", () => {
  it("picks the latest person-facing root agent of each open, unsorted session", () => {
    const recent = "2026-09-29T10:00:00.000Z";
    const candidates = handoffBackfillCandidates({
      workspaces: [
        { workspaceId: "open", doneAt: null, hasHandoff: false },
        { workspaceId: "done", doneAt: recent, hasHandoff: false },
        { workspaceId: "sorted", doneAt: null, hasHandoff: true },
        { workspaceId: "paperclip", doneAt: null, hasHandoff: false },
      ],
      agents: [
        {
          id: "old",
          cwd: "/a",
          workspaceId: "open",
          labels: {},
          lastActivityAt: "2026-09-29T08:00:00.000Z",
        },
        { id: "new", cwd: "/a", workspaceId: "open", labels: {}, lastActivityAt: recent },
        {
          id: "child",
          cwd: "/a",
          workspaceId: "open",
          labels: { "paseo.parent-agent-id": "new" },
          lastActivityAt: "2026-09-29T11:00:00.000Z",
        },
        { id: "d", cwd: "/b", workspaceId: "done", labels: {}, lastActivityAt: recent },
        { id: "s", cwd: "/c", workspaceId: "sorted", labels: {}, lastActivityAt: recent },
        {
          id: "dev",
          cwd: "/d",
          workspaceId: "paperclip",
          labels: { "paseo.origin": "paperclip:Dev" },
          lastActivityAt: recent,
        },
      ],
      sinceMs: Date.parse("2026-09-20T00:00:00.000Z"),
    });
    expect(candidates).toEqual([{ workspaceId: "open", agentId: "new", cwd: "/a" }]);
  });
});
