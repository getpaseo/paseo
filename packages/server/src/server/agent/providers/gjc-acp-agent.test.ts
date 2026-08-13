import { beforeEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";

const mockState = vi.hoisted(() => ({
  genericConstructorOptions: [] as unknown[],
}));

vi.mock("./generic-acp-agent.js", () => ({
  GenericACPAgentClient: class GenericACPAgentClient {
    readonly provider = "acp";

    constructor(options: unknown) {
      mockState.genericConstructorOptions.push(options);
    }
  },
}));

import { GjcACPAgentClient } from "./gjc-acp-agent.js";

describe("GjcACPAgentClient", () => {
  beforeEach(() => {
    mockState.genericConstructorOptions = [];
  });

  test("enables Paseo terminal execution and prompt permission handling for GJC ACP", () => {
    const _client = new GjcACPAgentClient({
      logger: createTestLogger(),
      command: ["gjc", "acp"],
      env: {
        GJC_LOG: "debug",
      },
      providerId: "gjc",
      label: "Gajae Code",
      providerParams: {
        supportsMcpServers: false,
      },
    });
    void _client;

    expect(mockState.genericConstructorOptions).toEqual([
      {
        logger: expect.any(Object),
        command: ["gjc", "acp"],
        env: {
          GJC_LOG: "debug",
        },
        providerId: "gjc",
        label: "Gajae Code",
        providerParams: {
          supportsMcpServers: false,
        },
        clientCapabilities: {
          terminal: true,
        },
        clientCapabilityMeta: {
          gjc: {
            permissionHandling: "prompt",
          },
        },
      },
    ]);
  });
});
