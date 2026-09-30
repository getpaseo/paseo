import { describe, expect, it } from "vitest";
import type { TeamEventPayload, TeamSummary } from "@getpaseo/protocol/messages";
import { buildTeamChatRows } from "./chat-model";

const team: TeamSummary = {
  id: "team_1",
  title: "Text helpers",
  status: "active",
  bossAgentId: "boss-agent",
  createdAt: "2026-09-30T08:00:00",
  items: [{ id: "item_1", title: "slugify", phase: "test", board: "item" }],
  lastEventAt: null,
};

function event(overrides: Partial<TeamEventPayload>): TeamEventPayload {
  return {
    commit: 1,
    at: "2026-10-01T09:05:00",
    type: "item.phase",
    actor: { type: "runtime", id: "runtime" },
    text: "slugify: Ready → Implement",
    ...overrides,
  };
}

describe("buildTeamChatRows", () => {
  it("renders members as bubbles, the person on the right and runtime events as system lines", () => {
    const rows = buildTeamChatRows({
      team,
      events: [
        event({ commit: 1, at: "2026-09-30T23:50:00" }),
        event({
          commit: 2,
          type: "report.accepted",
          actor: { type: "role", id: "developer" },
          workItemId: "item_1",
          text: "slugify done",
          data: { bindingId: "seat_1", outcome: "done" },
        }),
        event({ commit: 3, type: "human.message", actor: { type: "boss", id: "boss-agent" } }),
        event({ commit: 4, type: "human.message", actor: { type: "human", id: "user" } }),
        event({ commit: 5, type: "boss.notified", text: "slugify needs you" }),
      ],
      bindings: [
        {
          id: "seat_1",
          workItemId: "item_1",
          role: "developer",
          agentId: "dev-agent",
          turn: "reported",
          status: "active",
        },
      ],
      pending: [{ id: "p1", text: "Keep going", at: "2026-10-01T09:06:00" }],
      now: new Date("2026-10-01T12:00:00"),
    });

    expect(rows.map((row) => row.kind)).toEqual([
      "day",
      "system",
      "day",
      "bubble",
      "bubble",
      "bubble",
      "system",
      "bubble",
    ]);
    expect(rows[0]).toMatchObject({ label: "Yesterday" });
    expect(rows[2]).toMatchObject({ label: "Today" });
    expect(rows[3]).toMatchObject({
      mine: false,
      author: "Developer",
      tone: "developer",
      subtitle: "slugify",
      agentId: "dev-agent",
      time: "09:05",
    });
    expect(rows[4]).toMatchObject({ author: "Boss", tone: "boss", agentId: "boss-agent" });
    expect(rows[5]).toMatchObject({ mine: true, author: "You", subtitle: null });
    expect(rows[6]).toMatchObject({ kind: "system", attention: true });
    expect(rows[7]).toMatchObject({ mine: true, pending: true, text: "Keep going" });
  });
});
