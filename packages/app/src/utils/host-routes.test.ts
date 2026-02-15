import { describe, expect, it } from "vitest";
import {
  parseHostAgentDraftRouteFromPathname,
  parseHostAgentRouteFromPathname,
} from "./host-routes";

describe("parseHostAgentDraftRouteFromPathname", () => {
  it("parses draft route server id", () => {
    expect(parseHostAgentDraftRouteFromPathname("/h/local/agent")).toEqual({
      serverId: "local",
    });
  });

  it("parses encoded server id", () => {
    expect(
      parseHostAgentDraftRouteFromPathname("/h/team%20host/agent")
    ).toEqual({
      serverId: "team host",
    });
  });

  it("does not match agent detail routes", () => {
    expect(parseHostAgentDraftRouteFromPathname("/h/local/agent/abc123")).toBeNull();
  });
});

describe("parseHostAgentRouteFromPathname", () => {
  it("continues parsing detail routes", () => {
    expect(parseHostAgentRouteFromPathname("/h/local/agent/abc123")).toEqual({
      serverId: "local",
      agentId: "abc123",
    });
  });
});
