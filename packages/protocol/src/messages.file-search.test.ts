import { describe, expect, test } from "vitest";
import { validateWSOutboundMessage } from "./validation/ws-outbound.js";
import {
  FileSearchRequestSchema,
  FileSearchResponseSchema,
  ServerInfoStatusPayloadSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "./messages.js";

describe("workspace file content search messages", () => {
  test("keeps the capability optional and preserves advertised support", () => {
    const legacy = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "server-1",
      features: {},
    });
    expect(legacy.features?.fileContentSearch).toBeUndefined();

    const current = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "server-1",
      features: { fileContentSearch: true },
    });
    expect(current.features?.fileContentSearch).toBe(true);
  });

  test("round-trips bounded search requests through the inbound union", () => {
    const request = {
      type: "fs.search.request",
      cwd: "/workspace",
      query: "useSearch",
      caseSensitive: true,
      wholeWord: true,
      useRegex: false,
      includePattern: "*.ts,*.tsx",
      excludePattern: "*.test.ts",
      maxResults: 250,
      requestId: "search-1",
    } as const;

    expect(FileSearchRequestSchema.parse(request)).toEqual(request);
    expect(SessionInboundMessageSchema.parse(request)).toEqual(request);
    expect(() => FileSearchRequestSchema.parse({ ...request, query: "" })).toThrow();
    expect(() => FileSearchRequestSchema.parse({ ...request, maxResults: 2001 })).toThrow();
  });

  test("round-trips grouped navigable matches through the outbound union", () => {
    const response = {
      type: "fs.search.response",
      payload: {
        cwd: "/workspace",
        files: [
          {
            path: "src/search.ts",
            matches: [
              {
                line: 42,
                column: 7,
                matchLength: 9,
                lineContent: "const useSearch = createSearch();",
              },
            ],
          },
        ],
        totalMatches: 1,
        truncated: false,
        requestId: "search-1",
      },
    } as const;

    expect(FileSearchResponseSchema.parse(response)).toEqual(response);
    expect(SessionOutboundMessageSchema.parse(response)).toEqual(response);
    expect(validateWSOutboundMessage({ type: "session", message: response })).toMatchObject({
      success: true,
    });
  });
});
