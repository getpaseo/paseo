import { describe, expect, it } from "vitest";
import { CLIENT_CAPS } from "./client-capabilities.js";
import { WSHelloMessageSchema } from "./messages.js";

describe("client capabilities", () => {
  it("accepts canonical submitted prompt revision support in hello", () => {
    const hello = WSHelloMessageSchema.parse({
      type: "hello",
      clientId: "client-capability-test",
      clientType: "mobile",
      protocolVersion: 1,
      capabilities: {
        [CLIENT_CAPS.canonicalSubmittedPromptRevisions]: true,
      },
    });

    expect(hello.capabilities?.[CLIENT_CAPS.canonicalSubmittedPromptRevisions]).toBe(true);
  });
});
