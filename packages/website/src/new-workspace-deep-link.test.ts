import { describe, expect, it } from "vitest";
import { buildNewWorkspaceDeepLink, createNewWorkspaceRedirect } from "./new-workspace-deep-link";

describe("buildNewWorkspaceDeepLink", () => {
  it("keeps the prompt in the query string", () => {
    expect(buildNewWorkspaceDeepLink("/new?q=Fix%20it%20%26%20test%20it")).toBe(
      "paseo://new?q=Fix%20it%20%26%20test%20it",
    );
  });

  it("preserves supported query parameters alongside the prompt", () => {
    expect(
      buildNewWorkspaceDeepLink(
        "/new?serverId=host-1&dir=%2Frepo&name=Repo&projectId=project-1&draftId=draft-1&q=Start",
      ),
    ).toBe(
      "paseo://new?serverId=host-1&dir=%2Frepo&name=Repo&projectId=project-1&draftId=draft-1&q=Start",
    );
  });

  it("returns a temporary redirect for website requests", () => {
    const response = createNewWorkspaceRedirect(
      "https://paseo.sh/new?serverId=host-1&dir=%2Frepo&q=Start%20here",
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toBe(
      "paseo://new?serverId=host-1&dir=%2Frepo&q=Start%20here",
    );
  });
});
