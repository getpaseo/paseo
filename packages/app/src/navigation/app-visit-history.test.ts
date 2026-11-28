import { describe, expect, it } from "vitest";
import { createAppVisitHistory, type AppVisit } from "./app-visit-history";

const first = {
  kind: "workspace",
  serverId: "local",
  workspaceId: "project",
  tabId: "chat",
} as const;
const second = { ...first, tabId: "editor" };
const third = {
  kind: "workspace",
  serverId: "remote",
  workspaceId: "project",
  tabId: "terminal",
} as const;
const fourth = { ...first, tabId: "changes" };
const dashboard = {
  kind: "plugin",
  serverId: "local",
  pluginId: "review",
  identity: { kind: "surface", id: "dashboard" },
  href: "/h/local/plugin/review/surface/dashboard?param.filter=mine",
} as const;
const available = () => true;

function historyFromVisits(...visits: AppVisit[]) {
  const history = createAppVisitHistory();
  for (const visit of visits) history.record(visit);
  return history;
}

describe("app visit history", () => {
  it("replays across tabs and hosts, including when route commits lag behind rapid shortcuts", () => {
    const history = historyFromVisits(first, second, third);

    expect(history.move(-1, third, available)).toEqual({ visit: second, navigateRoute: true });
    expect(history.move(-1, third, available)).toEqual({ visit: first, navigateRoute: true });
    history.record(second);
    history.record(first);
    expect(history.move(-1, first, available)).toBeNull();
    expect(history.move(1, first, available)).toEqual({ visit: second, navigateRoute: false });
    history.record(second);
    expect(history.move(1, second, available)).toEqual({ visit: third, navigateRoute: true });
    history.record(third);
    expect(history.move(1, third, available)).toBeNull();
  });

  it("supersedes a pending workspace change when reversing direction", () => {
    const history = historyFromVisits(second, third);
    expect(history.move(-1, third, available)).toEqual({
      visit: second,
      navigateRoute: true,
    });
    expect(history.move(1, third, available)).toEqual({
      visit: third,
      navigateRoute: true,
    });
    expect(history.move(1, third, available)).toBeNull();
  });

  it.each([third, fourth])(
    "records a new visit after a coalesced round trip from $tabId",
    (start) => {
      const history = historyFromVisits(first, second, start);

      expect(history.move(-1, start, available)?.visit).toEqual(second);
      expect(history.move(1, start, available)?.visit).toEqual(start);
      // Neither replay commits a distinct selection before the user visits the editor again.
      history.record(second);

      expect(history.move(-1, second, available)?.visit).toEqual(start);
    },
  );

  it("skips closed visits and drops forward history after a new visit", () => {
    const history = historyFromVisits(first, second, third);

    expect(history.move(-1, third, (visit) => visit !== second)).toEqual({
      visit: first,
      navigateRoute: true,
    });
    history.record(first);
    history.record(fourth);
    expect(history.move(1, fourth, available)).toBeNull();
    expect(history.move(-1, fourth, available)).toEqual({ visit: first, navigateRoute: false });
  });

  it("returns to the last workspace visit from outside a workspace", () => {
    const history = historyFromVisits(first, second);

    expect(history.move(-1, null, available)).toEqual({ visit: second, navigateRoute: true });
    history.record(second);
    expect(history.move(-1, second, available)).toEqual({ visit: first, navigateRoute: false });
  });

  it.each([{ visits: [second] }, { visits: [first, second] }])(
    "returns to the latest visit when the active workspace has not been recorded ($#)",
    ({ visits }) => {
      const history = historyFromVisits(...visits);

      expect(history.move(-1, third, available)).toEqual({ visit: second, navigateRoute: true });
    },
  );

  it("retraces a plugin screen as a destination and skips it once unavailable", () => {
    const history = historyFromVisits(first, dashboard, second);

    expect(history.move(-1, second, available)).toEqual({ visit: dashboard, navigateRoute: true });
    history.record(dashboard);
    expect(history.move(-1, dashboard, available)).toEqual({ visit: first, navigateRoute: true });
    history.record(first);
    expect(history.move(1, first, (visit) => visit !== dashboard)).toEqual({
      visit: second,
      navigateRoute: false,
    });
  });

  it("returns from an unrecorded plugin screen and keeps moving on rapid Back presses", () => {
    const history = historyFromVisits(first, dashboard);
    const unavailablePlugin = { ...dashboard, pluginId: "unavailable" };

    expect(history.move(-1, unavailablePlugin, available)).toEqual({
      visit: dashboard,
      navigateRoute: true,
    });
    expect(history.move(-1, unavailablePlugin, available)).toEqual({
      visit: first,
      navigateRoute: true,
    });
  });
});
