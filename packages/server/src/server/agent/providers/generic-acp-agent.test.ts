import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";

const mockState = vi.hoisted(() => ({
  superConstructorOptions: [] as unknown[],
}));

vi.mock("./acp-agent.js", () => ({
  ACPAgentClient: class ACPAgentClient {
    readonly provider: string;

    constructor(options: unknown) {
      this.provider = "acp";
      mockState.superConstructorOptions.push(options);
    }
  },
}));

import { GenericACPAgentClient } from "./generic-acp-agent.js";

describe("GenericACPAgentClient", () => {
  test("passes the custom command only as defaultCommand", () => {
    new GenericACPAgentClient({
      logger: createTestLogger(),
      command: ["hermes", "acp"],
      env: {
        HERMES_LOG: "info",
      },
    });

    expect(mockState.superConstructorOptions).toEqual([
      {
        provider: "acp",
        logger: expect.any(Object),
        runtimeSettings: {
          env: {
            HERMES_LOG: "info",
          },
        },
        defaultCommand: ["hermes", "acp"],
      },
    ]);
  });
});
