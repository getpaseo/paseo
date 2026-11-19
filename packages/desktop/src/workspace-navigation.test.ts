import { describe, expect, it } from "vitest";
import {
  parseWorkspaceDeepLinkFromArgv,
  WorkspaceNavigationInbox,
} from "./workspace-navigation.js";

describe("desktop workspace navigation", () => {
  it("finds an exact workspace deep link among Electron launch arguments", () => {
    expect(
      parseWorkspaceDeepLinkFromArgv([
        "/Applications/Paseo.app/Contents/MacOS/Paseo",
        "--no-sandbox",
        "paseo://h/srv_devbox/open-project?path=%2Fhome%2Fmo%2Fworktree",
      ]),
    ).toEqual({ serverId: "srv_devbox", path: "/home/mo/worktree" });
  });

  it("holds cold navigation and keeps only the newest duplicate", () => {
    const inbox = new WorkspaceNavigationInbox();
    inbox.deliverOrQueue(7, { serverId: "srv_devbox", path: "/one" });
    inbox.deliverOrQueue(7, { serverId: "srv_devbox", path: "/two" });

    expect(inbox.windowReady(7)).toEqual({ serverId: "srv_devbox", path: "/two" });
    expect(inbox.windowReady(7)).toBeNull();
  });

  it("delivers warm navigation immediately", () => {
    const inbox = new WorkspaceNavigationInbox();
    inbox.windowReady(7);
    const target = { serverId: "srv_devbox", path: "/worktree" };
    expect(inbox.deliverOrQueue(7, target)).toEqual(target);
  });
});
