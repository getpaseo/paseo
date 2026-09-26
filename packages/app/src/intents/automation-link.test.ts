import { describe, expect, it } from "vitest";
import {
  MAX_LINK_PROMPT_LENGTH,
  buildAgentLinkRoute,
  buildWorkspaceLinkRoute,
  readLinkFlag,
  readLinkPrompt,
  resolveLinkHost,
} from "./automation-link";

describe("resolveLinkHost", () => {
  const hosts = [{ serverId: "laptop" }, { serverId: "desktop" }];

  it("honors a requested host that exists and rejects one that does not", () => {
    expect(
      resolveLinkHost({ requestedServerId: "desktop", hosts, lastServerId: "laptop" }),
    ).toEqual({ kind: "resolved", serverId: "desktop" });
    expect(resolveLinkHost({ requestedServerId: "phone", hosts, lastServerId: "laptop" })).toEqual({
      kind: "unknownHost",
      serverId: "phone",
    });
  });

  it("falls back to the last used host, then the only host", () => {
    expect(resolveLinkHost({ requestedServerId: null, hosts, lastServerId: "desktop" })).toEqual({
      kind: "resolved",
      serverId: "desktop",
    });
    expect(
      resolveLinkHost({ requestedServerId: null, hosts: [hosts[0]], lastServerId: "gone" }),
    ).toEqual({ kind: "resolved", serverId: "laptop" });
  });

  it("refuses to guess between several hosts and reports when none exist", () => {
    expect(resolveLinkHost({ requestedServerId: null, hosts, lastServerId: null })).toEqual({
      kind: "ambiguous",
    });
    expect(resolveLinkHost({ requestedServerId: null, hosts: [], lastServerId: null })).toEqual({
      kind: "noHosts",
    });
  });
});

describe("link params", () => {
  it("caps prompt length and normalizes line endings", () => {
    expect(readLinkPrompt("a\r\nb")).toBe("a\nb");
    expect(readLinkPrompt("x".repeat(MAX_LINK_PROMPT_LENGTH + 5))).toHaveLength(
      MAX_LINK_PROMPT_LENGTH,
    );
    expect(readLinkPrompt("   ")).toBeNull();
    expect(readLinkPrompt(["first", "second"])).toBe("first");
  });

  it("reads send flags strictly", () => {
    expect(readLinkFlag("true")).toBe(true);
    expect(readLinkFlag("1")).toBe(true);
    expect(readLinkFlag("false")).toBe(false);
    expect(readLinkFlag("please")).toBe(false);
    expect(readLinkFlag(undefined)).toBe(false);
  });
});

describe("route builders", () => {
  it("carries prompt and send into the host agent route", () => {
    expect(
      buildAgentLinkRoute({
        serverId: "my host",
        agentId: "agent/1",
        prompt: "run it & go",
        send: true,
      }),
    ).toBe("/h/my%20host/agent/agent%2F1?prompt=run+it+%26+go&send=true");
    expect(buildAgentLinkRoute({ serverId: "h", agentId: "a", prompt: null, send: false })).toBe(
      "/h/h/agent/a",
    );
  });

  it("opens a workspace on the named agent or terminal tab", () => {
    expect(
      buildWorkspaceLinkRoute({
        serverId: "h",
        workspaceId: "ws",
        agentId: "a1",
        terminalId: null,
      }),
    ).toBe("/h/h/workspace/ws?open=agent%3Aa1");
    expect(
      buildWorkspaceLinkRoute({
        serverId: "h",
        workspaceId: "ws",
        agentId: null,
        terminalId: "t1",
      }),
    ).toBe("/h/h/workspace/ws?open=terminal%3At1");
    expect(
      buildWorkspaceLinkRoute({
        serverId: "h",
        workspaceId: "ws",
        agentId: null,
        terminalId: null,
      }),
    ).toBe("/h/h/workspace/ws");
  });
});
