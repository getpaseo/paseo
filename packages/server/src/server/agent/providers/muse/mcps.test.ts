import { describe, expect, test, vi } from "vitest";
import type { Logger } from "pino";

import { mapMuseMcpServers } from "./mcps.js";

describe("mapMuseMcpServers", () => {
  test("maps stdio and http servers, skipping SSE with a warning", () => {
    const logger = { warn: vi.fn() } as unknown as Logger;

    const mapped = mapMuseMcpServers(
      {
        tools: { type: "stdio", command: "mcp-tools", args: ["--fast"] },
        paseo: {
          type: "http",
          url: "http://127.0.0.1:1/mcp/agents",
          headers: { Authorization: "Bearer token" },
        },
        legacy: { type: "sse", url: "http://127.0.0.1:1/sse" },
      },
      logger,
    );

    expect(mapped).toEqual({
      tools: { transport: "stdio", command: "mcp-tools", args: ["--fast"] },
      paseo: {
        transport: "streamableHttp",
        url: "http://127.0.0.1:1/mcp/agents",
        headers: { Authorization: "Bearer token" },
      },
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  test("returns undefined when nothing is mappable", () => {
    const logger = { warn: vi.fn() } as unknown as Logger;

    expect(mapMuseMcpServers(undefined, logger)).toBeUndefined();
    expect(mapMuseMcpServers({}, logger)).toBeUndefined();
  });
});
