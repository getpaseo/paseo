import { describe, expect, it } from "vitest";
import { parseAddHostDeepLink } from "@getpaseo/protocol/add-host-deep-link";
import { parseAgentDeepLink, type AgentDeepLinkTarget } from "@getpaseo/protocol/agent-deep-link";
import { DeepLinkInbox, findDeepLinkInArgv } from "./deep-link-inbox.js";

describe("desktop deep link inbox", () => {
  it("finds an agent deep link among Electron launch arguments", () => {
    expect(
      findDeepLinkInArgv(
        [
          "/Applications/Paseo.app/Contents/MacOS/Paseo",
          "--no-sandbox",
          "paseo://h/server-1/agent/agent-2",
        ],
        parseAgentDeepLink,
      ),
    ).toEqual({ serverId: "server-1", agentId: "agent-2" });
  });

  it("tells an add host link apart from an agent link in launch arguments", () => {
    const argv = [
      "C:\\Program Files\\Paseo\\Paseo.exe",
      "paseo://hosts/add?ssh=ssh%3A%2F%2Finstabox-dev-1",
    ];

    expect(findDeepLinkInArgv(argv, parseAddHostDeepLink)).toEqual({
      ssh: "ssh://instabox-dev-1",
    });
    expect(findDeepLinkInArgv(argv, parseAgentDeepLink)).toBeNull();
    expect(
      findDeepLinkInArgv(["paseo://h/server-1/agent/agent-2"], parseAddHostDeepLink),
    ).toBeNull();
  });

  it("holds navigation until the existing renderer is ready", () => {
    const inbox = new DeepLinkInbox<AgentDeepLinkTarget>();
    const target = { serverId: "server-1", agentId: "agent-2" };

    expect(inbox.deliverOrQueue(7, target)).toBeNull();
    expect(inbox.windowReady(7)).toEqual(target);
    expect(inbox.deliverOrQueue(7, target)).toEqual(target);
  });

  it("returns only the newest navigation queued during startup", () => {
    const inbox = new DeepLinkInbox<AgentDeepLinkTarget>();

    inbox.deliverOrQueue(7, { serverId: "server-1", agentId: "agent-1" });
    inbox.deliverOrQueue(7, { serverId: "server-1", agentId: "agent-2" });

    expect(inbox.windowReady(7)).toEqual({ serverId: "server-1", agentId: "agent-2" });
    expect(inbox.windowReady(7)).toBeNull();
  });

  it("queues again while a ready window reloads", () => {
    const inbox = new DeepLinkInbox<{ ssh: string }>();
    inbox.windowReady(7);
    inbox.windowLoading(7);

    expect(inbox.deliverOrQueue(7, { ssh: "ssh://devbox" })).toBeNull();
    expect(inbox.windowReady(7)).toEqual({ ssh: "ssh://devbox" });
  });
});
