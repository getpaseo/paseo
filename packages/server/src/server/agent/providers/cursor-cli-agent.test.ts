import { describe, expect, test } from "vitest";

import { CursorCliAgentClient } from "./cursor-cli-agent.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";

describe("CursorCliAgentClient", () => {
  test("exposes cursor provider id and capabilities", () => {
    const client = new CursorCliAgentClient({ logger: createTestLogger() });
    expect(client.provider).toBe("cursor");
    expect(client.capabilities.supportsStreaming).toBe(true);
    expect(client.capabilities.supportsSessionPersistence).toBe(true);
  });
});
