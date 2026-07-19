import { describe, expect, it } from "vitest";
import {
  buildHostAgentDetailRoute,
  buildHostRootRoute,
  buildHostWorkspaceOpenRoute,
  buildHostWorkspaceRoute,
  buildNewWorkspaceRoute,
  buildOpenProjectRoute,
  resolveKnownHostRoute,
  buildSessionsRoute,
  buildSettingsAddHostRoute,
  buildProjectSettingsRoute,
  buildProjectsSettingsRoute,
  decodeFilePathFromPathSegment,
  decodeWorkspaceIdFromPathSegment,
  encodeFilePathForPathSegment,
  encodeWorkspaceIdForPathSegment,
  isSettingsSectionSlug,
  normalizeHostSectionSlug,
  parseHostAgentRouteFromPathname,
  parseHostWorkspaceOpenIntentFromPathname,
  parseHostWorkspaceRouteFromPathname,
  parseWorkspaceOpenIntent,
  stripHostWorkspaceRouteEchoSearch,
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
    expect(decodeWorkspaceIdFromPathSegment("wks_10b3479c955fcc4c")).toBe("wks_10b3479c955fcc4c");
  });

  it("encodes non-URL-safe workspace IDs as base64url", () => {
    expect(encodeWorkspaceIdForPathSegment("/tmp/repo")).toBe("b64_L3RtcC9yZXBv");
    expect(decodeWorkspaceIdFromPathSegment("L3RtcC9yZXBv")).toBe("/tmp/repo");
  });

  it("decodes non-canonical base64url workspace IDs used by older links", () => {
    expect(decodeWorkspaceIdFromPathSegment("L2hvbWUvdXNlci9kZXYvcGFzZW8")).toBe(
      "/home/user/dev/paseo",
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

  it("strips route params repeated as workspace route search params", () => {
    expect(
      stripHostWorkspaceRouteEchoSearch(
        "/h/local/workspace/164?serverId=local&workspaceId=164&open=agent%3Aagent-1#pane",
      ),
    ).toBe("/h/local/workspace/164?open=agent%3Aagent-1#pane");
  });

  it("keeps non-route workspace search params", () => {
    expect(stripHostWorkspaceRouteEchoSearch("/h/local/workspace/164?workspaceId=other")).toBe(
      "/h/local/workspace/164?workspaceId=other",
    );
  });

  it("strips the React Navigation nested pop hint from workspace route search params", () => {
    expect(stripHostWorkspaceRouteEchoSearch("/h/local/workspace/164?pop=true")).toBe(
      "/h/local/workspace/164",
    );
    expect(
      stripHostWorkspaceRouteEchoSearch("/h/local/workspace/164?pop=true&open=agent%3Aagent-1"),
    ).toBe("/h/local/workspace/164?open=agent%3Aagent-1");
  });

  it("keeps non-navigation pop search params", () => {
    expect(stripHostWorkspaceRouteEchoSearch("/h/local/workspace/164?pop=false")).toBe(
      "/h/local/workspace/164?pop=false",
    );
    expect(stripHostWorkspaceRouteEchoSearch("/new?pop=true")).toBe("/new?pop=true");
  });

  it("strips encoded workspace route echoes", () => {
    expect(
      stripHostWorkspaceRouteEchoSearch(
        "/h/local/workspace/b64_L3RtcC9yZXBv?workspaceId=%2Ftmp%2Frepo",
      ),
    ).toBe("/h/local/workspace/b64_L3RtcC9yZXBv");
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

describe("projects settings routes", () => {
  it("buildSettingsAddHostRoute opens settings with the add-host flag", () => {
    expect(buildSettingsAddHostRoute()).toBe("/settings/general?addHost=1");
  });

  it("buildSettingsAddHostRoute accepts a repeatable intent id", () => {
    expect(buildSettingsAddHostRoute("retry 1")).toBe("/settings/general?addHost=retry%201");
  });

  it("buildProjectsSettingsRoute returns /settings/projects", () => {
    expect(buildProjectsSettingsRoute()).toBe("/settings/projects");
  });

  it("buildProjectSettingsRoute encodes a remote project key as a single segment", () => {
    expect(buildProjectSettingsRoute("remote:github.com/acme/app")).toBe(
      "/settings/projects/remote%3Agithub.com%2Facme%2Fapp",
    );
  });

  it("buildProjectSettingsRoute encodes a local repo-root key", () => {
    expect(buildProjectSettingsRoute("/Users/me/dev/paseo")).toBe(
      "/settings/projects/%2FUsers%2Fme%2Fdev%2Fpaseo",
    );
  });

  it("project keys round-trip through decodeURIComponent", () => {
    const projectKey = "remote:github.com/acme/app";
    const route = buildProjectSettingsRoute(projectKey);
    const segment = route.slice("/settings/projects/".length);
    expect(decodeURIComponent(segment)).toBe(projectKey);
  });
});

describe("global routes", () => {
  it("buildSessionsRoute returns the all-host Sessions route", () => {
    expect(buildSessionsRoute()).toBe("/sessions");
  });

  it("buildNewWorkspaceRoute returns the all-host New Workspace route", () => {
    expect(buildNewWorkspaceRoute()).toBe("/new");
  });

  it("buildNewWorkspaceRoute accepts an initial host", () => {
    expect(buildNewWorkspaceRoute({ serverId: "local" })).toBe("/new?serverId=local");
  });

  it("buildNewWorkspaceRoute accepts initial project context", () => {
    expect(
      buildNewWorkspaceRoute({
        serverId: "local",
        sourceDirectory: "/repo/project",
        displayName: "Project",
        projectId: "project-1",
      }),
    ).toBe("/new?serverId=local&dir=%2Frepo%2Fproject&name=Project&projectId=project-1");
  });

  it("buildNewWorkspaceRoute carries a draft context id", () => {
    expect(
      buildNewWorkspaceRoute({
        serverId: "local",
        sourceDirectory: "/repo/project",
        draftId: "draft-1",
      }),
    ).toBe("/new?serverId=local&dir=%2Frepo%2Fproject&draftId=draft-1");
  });
});

describe("host settings section slugs", () => {
  it("keeps current host settings sections", () => {
    expect(normalizeHostSectionSlug("connections")).toBe("connections");
    expect(normalizeHostSectionSlug("agents")).toBe("agents");
    expect(normalizeHostSectionSlug("workspaces")).toBe("workspaces");
    expect(normalizeHostSectionSlug("providers")).toBe("providers");
    expect(normalizeHostSectionSlug("usage")).toBe("usage");
    expect(normalizeHostSectionSlug("host")).toBe("host");
  });

  it("maps old host settings sections to their new names", () => {
    expect(normalizeHostSectionSlug("orchestration")).toBe("agents");
    expect(normalizeHostSectionSlug("daemon")).toBe("host");
  });
});

describe("settings section slugs", () => {
  it("no longer treats daemon as a valid app-level settings section", () => {
    expect(isSettingsSectionSlug("daemon")).toBe(false);
  });
});

describe("resolveKnownHostRoute", () => {
  it("renders when the route host is still saved", () => {
    expect(
      resolveKnownHostRoute({
        routeServerId: "srv-current",
        hosts: [{ serverId: "srv-current" }, { serverId: "srv-next" }],
      }),
    ).toEqual({ kind: "render" });
  });

  it("sends removed host routes to the host-agnostic open project screen", () => {
    expect(
      resolveKnownHostRoute({
        routeServerId: "srv-removed",
        hosts: [{ serverId: "srv-next" }],
      }),
    ).toEqual({ kind: "redirect", href: buildOpenProjectRoute() });
  });

  it("sends host routes to welcome when no hosts are saved", () => {
    expect(
      resolveKnownHostRoute({
        routeServerId: "srv-removed",
        hosts: [],
      }),
    ).toEqual({ kind: "redirect", href: "/welcome" });
  });
});
