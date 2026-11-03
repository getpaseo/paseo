import { describe, expect, it } from "vitest";
import {
  buildAgentDeepLink,
  buildAgentDeepLinkRoute,
  buildDesktopDeepLinkRoute,
  buildTerminalDeepLink,
  parseAgentDeepLink,
  parseDesktopDeepLink,
  parseTerminalDeepLink,
} from "./agent-deep-link.js";

describe("agent deep links", () => {
  it("round-trips an existing agent target", () => {
    const target = { serverId: "server/main", agentId: "agent 123" };

    const link = buildAgentDeepLink(target);

    expect(link).toBe("paseo://h/server%2Fmain/agent/agent%20123");
    expect(buildAgentDeepLinkRoute(target)).toBe("/h/server%2Fmain/agent/agent%20123");
    expect(parseAgentDeepLink(link)).toEqual(target);
  });

  it("rejects links outside the exact agent route", () => {
    expect(parseAgentDeepLink("https://h/server/agent/agent-1")).toBeNull();
    expect(parseAgentDeepLink("paseo://app/h/server/agent/agent-1")).toBeNull();
    expect(parseAgentDeepLink("paseo://h/server/agent/agent-1?message=hello")).toBeNull();
    expect(parseAgentDeepLink("paseo://h/server/agent/agent-1/extra")).toBeNull();
  });
});

describe("terminal deep links", () => {
  it("round-trips a workspace terminal target", () => {
    const target = { serverId: "server/main", workspaceId: "wks 1", terminalId: "term-2" };

    const link = buildTerminalDeepLink(target);

    expect(link).toBe("paseo://h/server%2Fmain/workspace/wks%201/terminal/term-2");
    expect(parseTerminalDeepLink(link)).toEqual(target);
    expect(parseAgentDeepLink(link)).toBeNull();
  });

  it("rejects links outside the exact terminal route", () => {
    expect(parseTerminalDeepLink("https://h/server/workspace/wks/terminal/term")).toBeNull();
    expect(parseTerminalDeepLink("paseo://app/h/server/workspace/wks/terminal/term")).toBeNull();
    expect(parseTerminalDeepLink("paseo://h/server/workspace/wks/terminal/term?x=1")).toBeNull();
    expect(parseTerminalDeepLink("paseo://h/server/workspace/wks/terminal/term/extra")).toBeNull();
    expect(parseTerminalDeepLink("paseo://h/server/workspace/wks/agent/term")).toBeNull();
    expect(parseTerminalDeepLink("paseo://h/server/workspace/%20/terminal/term")).toBeNull();
  });
});

describe("desktop deep links", () => {
  it("accepts either an agent or a terminal link", () => {
    expect(parseDesktopDeepLink("paseo://h/server/agent/agent-1")).toEqual({
      serverId: "server",
      agentId: "agent-1",
    });
    expect(parseDesktopDeepLink("paseo://h/server/workspace/wks/terminal/term")).toEqual({
      serverId: "server",
      workspaceId: "wks",
      terminalId: "term",
    });
    expect(parseDesktopDeepLink("paseo://h/server/workspace/wks")).toBeNull();
  });

  it("builds the in-app route for each target", () => {
    expect(buildDesktopDeepLinkRoute({ serverId: "server", agentId: "agent-1" })).toBe(
      "/h/server/agent/agent-1",
    );
    expect(
      buildDesktopDeepLinkRoute({ serverId: "server", workspaceId: "wks_1", terminalId: "term" }),
    ).toBe("/h/server/workspace/wks_1?open=terminal%3Aterm");
  });
});
