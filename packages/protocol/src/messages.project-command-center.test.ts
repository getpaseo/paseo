import { describe, expect, it } from "vitest";
import {
  parseServerInfoStatusPayload,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "./messages.js";

describe("project command-center protocol", () => {
  it("parses the dotted GitHub repository search request and normalized success response", () => {
    expect(
      SessionInboundMessageSchema.parse({
        type: "workspace.github.search_repositories.request",
        query: "paseo",
        limit: 12,
        requestId: "req-search",
      }),
    ).toEqual({
      type: "workspace.github.search_repositories.request",
      query: "paseo",
      limit: 12,
      requestId: "req-search",
    });

    expect(
      SessionOutboundMessageSchema.parse({
        type: "workspace.github.search_repositories.response",
        payload: {
          status: "success",
          requestId: "req-search",
          repositories: [
            {
              id: "R_paseo",
              name: "paseo",
              nameWithOwner: "getpaseo/paseo",
              description: "Development environment in your pocket",
              visibility: "public",
              updatedAt: "2026-07-15T10:00:00Z",
              cloneUrl: "git@github.com:getpaseo/paseo.git",
            },
          ],
          available: true,
          error: null,
        },
      }).payload,
    ).toEqual({
      status: "success",
      requestId: "req-search",
      repositories: [
        {
          id: "R_paseo",
          name: "paseo",
          nameWithOwner: "getpaseo/paseo",
          description: "Development environment in your pocket",
          visibility: "public",
          updatedAt: "2026-07-15T10:00:00Z",
          cloneUrl: "git@github.com:getpaseo/paseo.git",
        },
      ],
      available: true,
      error: null,
    });
  });

  it.each([
    { status: "unavailable", reason: "gh_missing", message: "gh is missing" },
    { status: "unauthenticated", message: "sign in" },
    { status: "error", message: "command failed" },
  ])("parses the GitHub $status runtime state", (payload) => {
    expect(
      SessionOutboundMessageSchema.safeParse({
        type: "workspace.github.search_repositories.response",
        payload: {
          requestId: "req-search",
          repositories: [],
          available: payload.status === "error",
          error: payload.message,
          ...payload,
        },
      }).success,
    ).toBe(true);
  });

  it("parses atomic project directory creation request and response", () => {
    expect(
      SessionInboundMessageSchema.safeParse({
        type: "project.create_directory.request",
        parentPath: "/Users/example/dev",
        name: "new-project",
        requestId: "req-create",
      }).success,
    ).toBe(true);

    expect(
      SessionOutboundMessageSchema.parse({
        type: "project.create_directory.response",
        payload: {
          requestId: "req-create",
          directoryPath: "/Users/example/dev/new-project",
          project: {
            projectId: "directory:/Users/example/dev/new-project",
            projectDisplayName: "new-project",
            projectCustomName: null,
            projectRootPath: "/Users/example/dev/new-project",
            projectKind: "non_git",
          },
          error: null,
          errorCode: null,
        },
      }).payload.project?.projectDisplayName,
    ).toBe("new-project");

    expect(
      SessionInboundMessageSchema.safeParse({
        type: "project.create_directory.request",
        parentPath: "",
        name: "",
        requestId: "req-invalid-create",
      }).success,
    ).toBe(true);
  });

  it("accepts future project directory error codes without transforming wire values", () => {
    expect(
      SessionOutboundMessageSchema.parse({
        type: "project.create_directory.response",
        payload: {
          requestId: "req-create",
          directoryPath: null,
          project: null,
          error: "A newer failure",
          errorCode: "future_failure_reason",
        },
      }).payload.errorCode,
    ).toBe("future_failure_reason");

    expect(
      SessionOutboundMessageSchema.parse({
        type: "workspace.github.search_repositories.response",
        payload: {
          status: "success",
          requestId: "req-search",
          repositories: [
            {
              id: "repo",
              name: " paseo ",
              nameWithOwner: " getpaseo/paseo ",
              description: null,
              visibility: "public",
              updatedAt: "2026-07-15T10:00:00Z",
              cloneUrl: " https://github.com/getpaseo/paseo ",
            },
          ],
          available: true,
          error: null,
        },
      }).payload.repositories[0]?.name,
    ).toBe(" paseo ");
  });

  it("keeps project command feature flags optional for older server_info payloads", () => {
    const parsed = parseServerInfoStatusPayload({
      status: "server_info",
      serverId: "server-old",
      features: {},
    });

    expect(parsed.features?.workspaceGithubRepositorySearch).toBeUndefined();
    expect(parsed.features?.projectGithubClone).toBeUndefined();
    expect(parsed.features?.projectCreateDirectory).toBeUndefined();
  });
});
