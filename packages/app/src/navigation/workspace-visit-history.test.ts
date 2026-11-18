import { describe, expect, it } from "vitest";
import { createWorkspaceVisitHistory, type WorkspaceVisit } from "./workspace-visit-history";

const first = { serverId: "local", workspaceId: "project", tabId: "chat" };
const second = { ...first, tabId: "editor" };
const third = { serverId: "remote", workspaceId: "project", tabId: "terminal" };
const fourth = { ...first, tabId: "changes" };
const available = () => true;

function historyFromVisits(...visits: WorkspaceVisit[]) {
  const history = createWorkspaceVisitHistory();
  for (const visit of visits) history.record(visit);
  return history;
}

describe("workspace visit history", () => {
  it("replays across tabs and hosts, including when route commits lag behind rapid shortcuts", () => {
    const history = historyFromVisits(first, second, third);

    expect(history.move(-1, third, available)).toEqual({ visit: second, navigateWorkspace: true });
    expect(history.move(-1, third, available)).toEqual({ visit: first, navigateWorkspace: true });
    history.record(second);
    history.record(first);
    expect(history.move(-1, first, available)).toBeNull();
    expect(history.move(1, first, available)).toEqual({ visit: second, navigateWorkspace: false });
    history.record(second);
    expect(history.move(1, second, available)).toEqual({ visit: third, navigateWorkspace: true });
    history.record(third);
    expect(history.move(1, third, available)).toBeNull();
  });

  it("supersedes a pending workspace change when reversing direction", () => {
    const history = historyFromVisits(second, third);
    expect(history.move(-1, third, available)).toEqual({
      visit: second,
      navigateWorkspace: true,
    });
    expect(history.move(1, third, available)).toEqual({
      visit: third,
      navigateWorkspace: true,
    });
    history.record(second);
    history.record(third);
    expect(history.move(1, third, available)).toBeNull();
  });

  it("skips closed visits and drops forward history after a new visit", () => {
    const history = historyFromVisits(first, second, third);

    expect(history.move(-1, third, (visit) => visit !== second)).toEqual({
      visit: first,
      navigateWorkspace: true,
    });
    history.record(first);
    history.record(fourth);
    expect(history.move(1, fourth, available)).toBeNull();
    expect(history.move(-1, fourth, available)).toEqual({ visit: first, navigateWorkspace: false });
  });

  it("returns to the last workspace visit from outside a workspace", () => {
    const history = historyFromVisits(first, second);

    expect(history.move(-1, null, available)).toEqual({ visit: second, navigateWorkspace: true });
    history.record(second);
    expect(history.move(-1, second, available)).toEqual({ visit: first, navigateWorkspace: false });
  });
});
