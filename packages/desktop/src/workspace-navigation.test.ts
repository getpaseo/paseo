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
        "paseo://h/srv_devbox/open-workspace?path=%2Fhome%2Fmo%2Fworktree",
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

  it("discards a queued link when a newer link targets another window", () => {
    const inbox = new WorkspaceNavigationInbox();
    inbox.deliverOrQueue(7, { serverId: "srv_devbox", path: "/old" });
    inbox.windowReady(8);
    const target = { serverId: "srv_devbox", path: "/new" };

    expect(inbox.deliverOrQueue(8, target)).toEqual(target);
    expect(inbox.windowReady(7)).toBeNull();
  });

  it("delivers warm navigation immediately", () => {
    const inbox = new WorkspaceNavigationInbox();
    inbox.windowReady(7);
    const target = { serverId: "srv_devbox", path: "/worktree" };
    expect(inbox.deliverOrQueue(7, target)).toEqual(target);
  });

  it("drops queued workspace navigation when the window receives an agent link", () => {
    const inbox = new WorkspaceNavigationInbox();
    const target = { serverId: "srv_devbox", path: "/worktree" };
    expect(inbox.deliverOrQueue(7, target)).toBeNull();

    inbox.cancel(7);

    expect(inbox.windowReady(7)).toBeNull();
    expect(inbox.deliverOrQueue(7, target)).toEqual(target);
  });

  it("flushes a link queued after an earlier cancellation", () => {
    const inbox = new WorkspaceNavigationInbox();
    const older = { serverId: "srv_devbox", path: "/old" };
    const newer = { ...older, path: "/new" };
    inbox.deliverOrQueue(7, older);
    inbox.cancel(7);
    expect(inbox.deliverOrQueue(7, newer)).toBeNull();

    expect(inbox.windowReady(7)).toEqual(newer);
    expect(inbox.windowReady(7)).toBeNull();
  });
});
