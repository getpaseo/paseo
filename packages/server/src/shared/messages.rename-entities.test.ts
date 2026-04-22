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
  test("parses rename_terminal_request", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "rename_terminal_request",
      terminalId: "terminal-1",
      title: "Server logs",
      requestId: "request-terminal-rename",
    });

    expect(parsed).toEqual({
      type: "rename_terminal_request",
      terminalId: "terminal-1",
      title: "Server logs",
      requestId: "request-terminal-rename",
    });
  });

  test("rejects rename_terminal_request when required fields are missing", () => {
    const result = SessionInboundMessageSchema.safeParse({
      type: "rename_terminal_request",
      terminalId: "terminal-1",
      requestId: "request-terminal-rename",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toContain("title");
    }
  });

  test("parses rename_terminal_response with explicit null error", () => {
    const parsed = SessionOutboundMessageSchema.parse({
      type: "rename_terminal_response",
      payload: {
        requestId: "request-terminal-rename",
        success: true,
        error: null,
      },
    });

    expect(parsed).toEqual({
      type: "rename_terminal_response",
      payload: {
        requestId: "request-terminal-rename",
        success: true,
        error: null,
      },
    });
  });

  test("rejects rename_terminal_response without an explicit error", () => {
    const result = SessionOutboundMessageSchema.safeParse({
      type: "rename_terminal_response",
      payload: {
        requestId: "request-terminal-rename",
        success: true,
      },
    });

    expect(result.success).toBe(false);
  });

  test("parses checkout_rename_branch_request", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "checkout_rename_branch_request",
      cwd: "/tmp/repo",
      branch: "feature/new-name",
      requestId: "request-branch-rename",
    });

    expect(parsed).toEqual({
      type: "checkout_rename_branch_request",
      cwd: "/tmp/repo",
      branch: "feature/new-name",
      requestId: "request-branch-rename",
    });
  });

  test("rejects checkout_rename_branch_request when required fields are missing", () => {
    const result = SessionInboundMessageSchema.safeParse({
      type: "checkout_rename_branch_request",
      cwd: "/tmp/repo",
      requestId: "request-branch-rename",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toContain("branch");
    }
  });

  test("parses checkout_rename_branch_response with explicit nullable fields", () => {
    const parsed = SessionOutboundMessageSchema.parse({
      type: "checkout_rename_branch_response",
      payload: {
        requestId: "request-branch-rename",
        success: false,
        cwd: "/tmp/repo",
        currentBranch: null,
        error: {
          code: "UNKNOWN",
          message: "Branch name cannot be empty",
        },
      },
    });

    expect(parsed).toEqual({
      type: "checkout_rename_branch_response",
      payload: {
        requestId: "request-branch-rename",
        success: false,
        cwd: "/tmp/repo",
        currentBranch: null,
        error: {
          code: "UNKNOWN",
          message: "Branch name cannot be empty",
        },
      },
    });
  });

  test("rejects checkout_rename_branch_response without an explicit currentBranch", () => {
    const result = SessionOutboundMessageSchema.safeParse({
      type: "checkout_rename_branch_response",
      payload: {
        requestId: "request-branch-rename",
        success: false,
        cwd: "/tmp/repo",
        error: {
          code: "UNKNOWN",
          message: "Branch name cannot be empty",
        },
      },
    });

    expect(result.success).toBe(false);
  });

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
      "rename_terminal_request",
      "checkout_rename_branch_request",
    ]);
    const legacyOutboundSchema = schemaWithoutMessageTypes(SessionOutboundMessageSchema, [
      "rename_terminal_response",
      "checkout_rename_branch_response",
    ]);

    expect(
      legacyInboundSchema.safeParse({
        type: "rename_terminal_request",
        terminalId: "terminal-1",
        title: "Server logs",
        requestId: "request-terminal-rename",
      }).success,
    ).toBe(false);
    expect(
      legacyInboundSchema.safeParse({
        type: "checkout_rename_branch_request",
        cwd: "/tmp/repo",
        branch: "feature/new-name",
        requestId: "request-branch-rename",
      }).success,
    ).toBe(false);
    expect(
      legacyOutboundSchema.safeParse({
        type: "rename_terminal_response",
        payload: {
          requestId: "request-terminal-rename",
          success: true,
          error: null,
        },
      }).success,
    ).toBe(false);
    expect(
      legacyOutboundSchema.safeParse({
        type: "checkout_rename_branch_response",
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
