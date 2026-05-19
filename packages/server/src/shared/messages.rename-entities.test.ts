import { z } from "zod";
import { describe, expect, test } from "vitest";
import { SessionInboundMessageSchema, SessionOutboundMessageSchema } from "./messages.js";

type SessionMessageOption = z.ZodDiscriminatedUnionOption<"type">;

function schemaWithoutMessageTypes(
  schema: { options: SessionMessageOption[] },
  excludedTypes: string[],
) {
  const excluded = new Set(excludedTypes);
  const options = schema.options.filter((option) => !excluded.has(option.shape.type.value));

  return z.discriminatedUnion("type", options as [SessionMessageOption, ...SessionMessageOption[]]);
}

describe("rename entity message schemas", () => {
  test("new client schema still parses old daemon checkout and terminal responses", () => {
    const checkoutResponse = SessionOutboundMessageSchema.parse({
      type: "checkout_switch_branch_response",
      payload: {
        cwd: "/tmp/repo",
        success: true,
        branch: "main",
        source: "local",
        error: null,
        requestId: "request-switch",
      },
    });
    const terminalResponse = SessionOutboundMessageSchema.parse({
      type: "kill_terminal_response",
      payload: {
        terminalId: "terminal-1",
        success: true,
        requestId: "request-kill",
      },
    });

    expect(checkoutResponse).toEqual({
      type: "checkout_switch_branch_response",
      payload: {
        cwd: "/tmp/repo",
        success: true,
        branch: "main",
        source: "local",
        error: null,
        requestId: "request-switch",
      },
    });
    expect(terminalResponse).toEqual({
      type: "kill_terminal_response",
      payload: {
        terminalId: "terminal-1",
        success: true,
        requestId: "request-kill",
      },
    });
  });

  test("old unions without rename variants reject rename messages and still parse existing messages", () => {
    const legacyInboundSchema = schemaWithoutMessageTypes(SessionInboundMessageSchema, [
      "terminal.rename.request",
      "checkout.rename_branch.request",
    ]);
    const legacyOutboundSchema = schemaWithoutMessageTypes(SessionOutboundMessageSchema, [
      "terminal.rename.response",
      "checkout.rename_branch.response",
    ]);

    expect(
      legacyInboundSchema.safeParse({
        type: "terminal.rename.request",
        terminalId: "terminal-1",
        title: "Server logs",
        requestId: "request-terminal-rename",
      }).success,
    ).toBe(false);
    expect(
      legacyInboundSchema.safeParse({
        type: "checkout.rename_branch.request",
        cwd: "/tmp/repo",
        branch: "feature/new-name",
        requestId: "request-branch-rename",
      }).success,
    ).toBe(false);
    expect(
      legacyOutboundSchema.safeParse({
        type: "terminal.rename.response",
        payload: {
          requestId: "request-terminal-rename",
          success: true,
          error: null,
        },
      }).success,
    ).toBe(false);
    expect(
      legacyOutboundSchema.safeParse({
        type: "checkout.rename_branch.response",
        payload: {
          requestId: "request-branch-rename",
          success: true,
          cwd: "/tmp/repo",
          currentBranch: "feature/new-name",
          error: null,
        },
      }).success,
    ).toBe(false);

    expect(
      legacyInboundSchema.parse({
        type: "checkout_switch_branch_request",
        cwd: "/tmp/repo",
        branch: "main",
        requestId: "request-switch",
      }),
    ).toEqual({
      type: "checkout_switch_branch_request",
      cwd: "/tmp/repo",
      branch: "main",
      requestId: "request-switch",
    });
    expect(
      legacyOutboundSchema.parse({
        type: "kill_terminal_response",
        payload: {
          terminalId: "terminal-1",
          success: true,
          requestId: "request-kill",
        },
      }),
    ).toEqual({
      type: "kill_terminal_response",
      payload: {
        terminalId: "terminal-1",
        success: true,
        requestId: "request-kill",
      },
    });
  });
});
