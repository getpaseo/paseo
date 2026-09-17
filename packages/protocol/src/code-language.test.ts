import { expect, test } from "vitest";
import { SessionInboundMessageSchema } from "./messages.js";
import { validateWSOutboundMessage } from "./validation/ws-outbound.js";

test("language requests validate positions and the generated client validator accepts results", () => {
  const request = {
    type: "code.language.query.request",
    requestId: "query",
    cwd: "/repo",
    path: "a.ts",
    version: 1,
    position: { line: 0, character: 5 },
    operation: "hover",
  };
  expect(SessionInboundMessageSchema.safeParse(request).success).toBe(true);
  expect(
    SessionInboundMessageSchema.safeParse({ ...request, position: { line: -1, character: 5 } })
      .success,
  ).toBe(false);
  expect(
    validateWSOutboundMessage({
      type: "session",
      message: {
        type: "code.language.query.response",
        payload: {
          requestId: "query",
          version: 1,
          generation: "generation",
          result: { kind: "hover", text: "const value: number", range: null },
        },
      },
    }).success,
  ).toBe(true);
});
