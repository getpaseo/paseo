import { describe, expect, test } from "vitest";
import {
  ProjectNestedReposScanRequestSchema,
  ProjectNestedReposScanResponseSchema,
  ServerInfoStatusPayloadSchema,
} from "./messages.js";

describe("project nested repos messages", () => {
  test("keeps the capability optional for older server info payloads", () => {
    expect(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "server-1",
        features: {},
      }).features?.projectNestedRepos,
    ).toBeUndefined();
  });

  test("parses the scan request and response", () => {
    expect(
      ProjectNestedReposScanRequestSchema.parse({
        type: "project.nested_repos.scan_request",
        parentCwd: "/projects",
        requestId: "request-1",
      }).parentCwd,
    ).toBe("/projects");
    expect(
      ProjectNestedReposScanResponseSchema.parse({
        type: "project.nested_repos.scan_response",
        payload: {
          parentCwd: "/projects",
          repos: [{ path: "/projects/app", name: "app", isWorktree: false, branch: "main" }],
          error: null,
          requestId: "request-1",
        },
      }).payload.repos[0]?.name,
    ).toBe("app");
  });
});
