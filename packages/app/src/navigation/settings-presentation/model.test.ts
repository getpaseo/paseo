import { describe, expect, it } from "vitest";
import { createSettingsPresentation } from "./model";

describe("Settings host selection", () => {
  it("keeps picker choices across sections, replacement and Back", () => {
    const settings = createSettingsPresentation();
    settings.enterRoute({ key: "/settings", pathname: "/settings" }, "workspace-host");
    expect(settings.store.getState().selectedServerId).toBe("workspace-host");
    settings.selectHost("chosen-host");
    settings.enterRoute(
      {
        key: "/settings/hosts/chosen-host/connections",
        pathname: "/settings/hosts/chosen-host/connections",
      },
      "workspace-host",
    );
    settings.enterRoute({ key: "/settings", pathname: "/settings" }, "workspace-host");
    settings.enterRoute(
      { key: "/settings/appearance", pathname: "/settings/appearance" },
      "workspace-host",
    );
    settings.enterRoute(
      { key: "/settings/general", pathname: "/settings/general" },
      "workspace-host",
    );
    expect(settings.store.getState().selectedServerId).toBe("chosen-host");
  });

  it("applies explicit host links once, including project and plugin screens", () => {
    const settings = createSettingsPresentation();
    settings.enterRoute(
      {
        key: "/settings/hosts/linked-host/projects/project",
        pathname: "/settings/hosts/linked-host/projects/project",
      },
      "workspace-host",
    );
    expect(settings.store.getState().selectedServerId).toBe("linked-host");
    settings.selectHost("chosen-host");
    settings.enterRoute(
      {
        key: "/settings/hosts/linked-host/projects/project",
        pathname: "/settings/hosts/linked-host/projects/project",
      },
      "workspace-host",
    );
    expect(settings.store.getState().selectedServerId).toBe("chosen-host");
    settings.enterRoute(
      {
        key: "/settings/hosts/plugin-host/plugins/plugin/screen",
        pathname: "/settings/hosts/plugin-host/plugins/plugin/screen",
      },
      "workspace-host",
    );
    expect(settings.store.getState().selectedServerId).toBe("plugin-host");
  });

  it("seeds each new visit from the workspace, including a retained settings route", () => {
    const settings = createSettingsPresentation();
    settings.enterRoute(
      { key: "/settings/general", pathname: "/settings/general" },
      "first-workspace-host",
    );
    settings.selectHost("chosen-host");
    settings.enterRoute(
      {
        key: "/h/second-workspace-host/workspace/workspace",
        pathname: "/h/second-workspace-host/workspace/workspace",
      },
      "second-workspace-host",
    );
    settings.enterRoute(
      { key: "/settings/general", pathname: "/settings/general" },
      "second-workspace-host",
    );
    expect(settings.store.getState().selectedServerId).toBe("second-workspace-host");
  });

  it("does not replay a retained host route after a newer picker choice", () => {
    const settings = createSettingsPresentation();
    const oldRoute = { key: "old-host-screen", pathname: "/settings/hosts/first/host" };
    settings.enterRoute(oldRoute, "workspace-host");
    settings.selectHost("second");
    settings.enterRoute(
      { key: "new-host-screen", pathname: "/settings/hosts/second/host" },
      "workspace-host",
    );
    settings.enterRoute(oldRoute, "workspace-host");
    settings.enterRoute({ key: "app-screen", pathname: "/settings/appearance" }, "workspace-host");
    expect(settings.store.getState().selectedServerId).toBe("second");
    settings.enterRoute({ ...oldRoute, key: "explicit-new-entry" }, "workspace-host");
    expect(settings.store.getState().selectedServerId).toBe("first");
  });

  it("does not reseed a visit when remembered workspace state changes", () => {
    const settings = createSettingsPresentation();
    settings.enterRoute({ key: "/settings", pathname: "/settings" }, null);
    settings.selectHost("chosen-host");
    settings.enterRoute({ key: "/settings", pathname: "/settings" }, "workspace-host");
    expect(settings.store.getState().selectedServerId).toBe("chosen-host");
  });
});

describe("Settings sidebar presentation", () => {
  it("restores across replacements and rejects callbacks from older sidebars", () => {
    const settings = createSettingsPresentation();
    settings.enterRoute({ key: "app", pathname: "/settings/general" }, "host");
    const oldSidebar = settings.attachSidebar();
    oldSidebar.remember(246);
    settings.enterRoute({ key: "host", pathname: "/settings/hosts/host/providers" }, "host");
    const currentSidebar = settings.attachSidebar();
    expect(currentSidebar.offset).toBe(246);
    oldSidebar.remember(0);
    oldSidebar.detach();
    expect(currentSidebar.offset).toBe(246);
    currentSidebar.remember(190);
    currentSidebar.detach();
    currentSidebar.remember(0);
    expect(settings.attachSidebar().offset).toBe(190);
  });

  it("resets on leaving Settings and rejects callbacks from a previous visit", () => {
    const settings = createSettingsPresentation();
    settings.enterRoute({ key: "app", pathname: "/settings/general" }, "host");
    const previousVisit = settings.attachSidebar();
    previousVisit.remember(246);
    settings.enterRoute({ key: "workspace", pathname: "/h/host/workspace/workspace" }, "host");
    settings.enterRoute({ key: "app", pathname: "/settings/general" }, "host");
    previousVisit.remember(246);
    expect(settings.attachSidebar().offset).toBe(0);
  });
});
