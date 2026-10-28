import { describe, expect, it } from "vitest";
import {
  CreateTerminalRequestSchema,
  CreateTerminalResponseSchema,
  ListTerminalsResponseSchema,
  TerminalsChangedSchema,
} from "./messages";

describe("terminal presentation", () => {
  const request = {
    type: "create_terminal_request" as const,
    cwd: "/work/repo",
    requestId: "request-1",
  };
  const terminal = { id: "terminal-1", name: "Terminal", cwd: request.cwd };

  it("preserves the legacy request and response shapes when presentation is absent", () => {
    expect(CreateTerminalRequestSchema.parse(request)).toEqual(request);
    const response = {
      type: "create_terminal_response",
      payload: { terminal, error: null, requestId: request.requestId },
    };
    expect(CreateTerminalResponseSchema.parse(response)).toEqual(response);
  });

  it.each(["standalone", "embedded"] as const)(
    "carries %s through creation, listing and broadcasts",
    (presentation) => {
      expect(CreateTerminalRequestSchema.parse({ ...request, presentation }).presentation).toBe(
        presentation,
      );
      const info = { ...terminal, presentation };
      expect(
        CreateTerminalResponseSchema.parse({
          type: "create_terminal_response",
          payload: { terminal: info, error: null, requestId: request.requestId },
        }).payload.terminal,
      ).toEqual(info);
      expect(
        ListTerminalsResponseSchema.parse({
          type: "list_terminals_response",
          payload: { terminals: [info], requestId: request.requestId },
        }).payload.terminals,
      ).toEqual([info]);
      const { cwd, ...listed } = info;
      expect(
        TerminalsChangedSchema.parse({
          type: "terminals_changed",
          payload: { cwd, terminals: [listed] },
        }).payload.terminals,
      ).toEqual([listed]);
    },
  );

  it("rejects an unknown presentation", () => {
    expect(() =>
      CreateTerminalRequestSchema.parse({ ...request, presentation: "hidden" }),
    ).toThrow();
  });
});
