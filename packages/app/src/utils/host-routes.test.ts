import { describe, expect, it } from "vitest";
import {
  buildHostAgentDetailRoute,
  buildHostRootRoute,
  buildHostWorkspaceOpenRoute,
  buildHostWorkspaceRoute,
  decodeFilePathFromPathSegment,
  decodeWorkspaceIdFromPathSegment,
  encodeFilePathForPathSegment,
  encodeWorkspaceIdForPathSegment,
  parseHostAgentRouteFromPathname,
  parseHostWorkspaceOpenIntentFromPathname,
  parseHostWorkspaceRouteFromPathname,
  parseWorkspaceOpenIntent,
} from "./host-routes";

describe("parseHostAgentRouteFromPathname", () => {
  it("continues parsing detail routes", () => {
    expect(parseHostAgentRouteFromPathname("/h/local/agent/abc123")).toEqual({
      serverId: "local",
      agentId: "abc123",
    });
  });
});

describe("workspace route parsing", () => {
  it("keeps URL-safe workspace IDs unencoded", () => {
    expect(encodeWorkspaceIdForPathSegment("164")).toBe("164");
    expect(decodeWorkspaceIdFromPathSegment("164")).toBe("164");
  });

  it("encodes non-URL-safe workspace IDs as base64url", () => {
    expect(encodeWorkspaceIdForPathSegment("/tmp/repo")).toBe("b64_L3RtcC9yZXBv");
    expect(decodeWorkspaceIdFromPathSegment("L3RtcC9yZXBv")).toBe("/tmp/repo");
  });

  it("decodes non-canonical base64url workspace IDs used by older links", () => {
    expect(decodeWorkspaceIdFromPathSegment("L1VzZXJzL21vYm91ZHJhL2Rldi9wYXNlby")).toBe(
      "/Users/moboudra/dev/paseo",
    );
  });

  it("encodes file paths as base64url (no padding)", () => {
    const encoded = encodeFilePathForPathSegment("src/index.ts");
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeFilePathFromPathSegment(encoded)).toBe("src/index.ts");
  });

  it("parses workspace route with a plain workspace id", () => {
    expect(parseHostWorkspaceRouteFromPathname("/h/local/workspace/164")).toEqual({
      serverId: "local",
      workspaceId: "164",
    });
  });

  it("parses workspace route with legacy base64 path", () => {
    expect(parseHostWorkspaceRouteFromPathname("/h/local/workspace/L3RtcC9yZXBv")).toEqual({
      serverId: "local",
      workspaceId: "/tmp/repo",
    });
  });

  it("does not treat /tab routes as valid workspace routes", () => {
    expect(
      parseHostWorkspaceRouteFromPathname("/h/local/workspace/L3RtcC9yZXBv/tab/draft_abc123"),
    ).toBeNull();
  });

  it("builds plain workspace routes for URL-safe ids", () => {
    expect(buildHostWorkspaceRoute("local", "164")).toBe("/h/local/workspace/164");
  });

  it("builds base64url workspace routes for legacy paths", () => {
    expect(buildHostWorkspaceRoute("local", "/tmp/repo")).toBe(
      "/h/local/workspace/b64_L3RtcC9yZXBv",
    );
  });

  it("builds host root routes", () => {
    expect(buildHostRootRoute("local")).toBe("/h/local");
  });

  it("parses workspace open intent from pathname query", () => {
    expect(
      parseHostWorkspaceOpenIntentFromPathname("/h/local/workspace/164?open=agent%3Aagent-1"),
    ).toEqual({
      kind: "agent",
      agentId: "agent-1",
    });
    expect(parseWorkspaceOpenIntent("terminal:term-1")).toEqual({
      kind: "terminal",
      terminalId: "term-1",
    });
    expect(parseWorkspaceOpenIntent("draft:new")).toEqual({
      kind: "draft",
      draftId: "new",
    });
    expect(parseWorkspaceOpenIntent("file:c3JjL2luZGV4LnRz")).toEqual({
      kind: "file",
      path: "src/index.ts",
    });
    expect(parseWorkspaceOpenIntent("setup:L3RtcC9yZXBv")).toEqual({
      kind: "setup",
      workspaceId: "/tmp/repo",
    });
  });

  it("uses the plain workspace route when workspace context is provided", () => {
    expect(buildHostAgentDetailRoute("local", "agent-1", "164")).toBe(
      "/h/local/workspace/164?open=agent%3Aagent-1",
    );
  });

  it("builds workspace routes with a one-shot open intent", () => {
    expect(buildHostWorkspaceOpenRoute("local", "164", "draft:new")).toBe(
      "/h/local/workspace/164?open=draft%3Anew",
    );
  });

  it("round-trips URL-safe IDs through encode/decode", () => {
    const ids = ["1", "40", "164", "9999", "workspace-1", "opaque_id.v2~test"];
    for (const id of ids) {
      const encoded = encodeWorkspaceIdForPathSegment(id);
      const decoded = decodeWorkspaceIdFromPathSegment(encoded);
      expect(decoded).toBe(id);
    }
  });

  it("round-trips opaque IDs with reserved characters through base64 encoding", () => {
    const id = "  team/setup:id#1  ";
    const encoded = encodeWorkspaceIdForPathSegment(id);
    expect(encoded).toBe("b64_dGVhbS9zZXR1cDppZCMx");
    expect(decodeWorkspaceIdFromPathSegment(encoded)).toBe("team/setup:id#1");
  });
});
