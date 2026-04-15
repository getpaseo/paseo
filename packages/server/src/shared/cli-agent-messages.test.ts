import { describe, expect, test } from "vitest";
import {
  CliAgentStatusCodeSchema,
  CliAgentStatusEntrySchema,
  CliAgentListRequestSchema,
  CliAgentListResponseSchema,
  CliAgentStatusUpdateSchema,
  CreateTerminalRequestSchema,
} from "./messages.js";

describe("CLI Agent Message Schemas", () => {
  describe("CliAgentStatusCodeSchema", () => {
    test("accepts valid status codes", () => {
      expect(CliAgentStatusCodeSchema.parse("connected")).toBe("connected");
      expect(CliAgentStatusCodeSchema.parse("missing")).toBe("missing");
      expect(CliAgentStatusCodeSchema.parse("error")).toBe("error");
    });

    test("rejects invalid status", () => {
      expect(() => CliAgentStatusCodeSchema.parse("unknown")).toThrow();
      expect(() => CliAgentStatusCodeSchema.parse("")).toThrow();
    });
  });

  describe("CliAgentStatusEntrySchema", () => {
    test("parses a connected agent", () => {
      const entry = CliAgentStatusEntrySchema.parse({
        id: "claude",
        name: "Claude Code",
        status: "connected",
        version: "1.2.3",
        path: "/usr/local/bin/claude",
        docUrl: "https://docs.anthropic.com",
        installCommand: "npm i -g @anthropic-ai/claude",
        cli: "claude",
      });
      expect(entry.status).toBe("connected");
      expect(entry.version).toBe("1.2.3");
    });

    test("parses a missing agent with nullable fields", () => {
      const entry = CliAgentStatusEntrySchema.parse({
        id: "gemini",
        name: "Gemini",
        status: "missing",
        version: null,
        path: null,
      });
      expect(entry.status).toBe("missing");
      expect(entry.version).toBeNull();
    });

    test("optional fields can be omitted", () => {
      const entry = CliAgentStatusEntrySchema.parse({
        id: "codex",
        name: "Codex",
        status: "connected",
      });
      expect(entry.id).toBe("codex");
      expect(entry.version).toBeUndefined();
    });
  });

  describe("CliAgentListRequestSchema", () => {
    test("parses basic request", () => {
      const req = CliAgentListRequestSchema.parse({
        type: "cli_agent_list_request",
        requestId: "req-1",
      });
      expect(req.type).toBe("cli_agent_list_request");
      expect(req.refresh).toBeUndefined();
    });

    test("parses request with refresh flag", () => {
      const req = CliAgentListRequestSchema.parse({
        type: "cli_agent_list_request",
        requestId: "req-2",
        refresh: true,
      });
      expect(req.refresh).toBe(true);
    });
  });

  describe("CliAgentListResponseSchema", () => {
    test("parses response with agents", () => {
      const res = CliAgentListResponseSchema.parse({
        type: "cli_agent_list_response",
        payload: {
          requestId: "req-1",
          agents: [
            { id: "claude", name: "Claude Code", status: "connected", version: "2.0.0" },
            { id: "codex", name: "Codex", status: "missing" },
          ],
        },
      });
      expect(res.payload.agents).toHaveLength(2);
      expect(res.payload.agents[0].status).toBe("connected");
    });

    test("parses response with error", () => {
      const res = CliAgentListResponseSchema.parse({
        type: "cli_agent_list_response",
        payload: {
          requestId: "req-1",
          agents: [],
          error: "Detection timed out",
        },
      });
      expect(res.payload.error).toBe("Detection timed out");
    });
  });

  describe("CliAgentStatusUpdateSchema", () => {
    test("parses status update push message", () => {
      const msg = CliAgentStatusUpdateSchema.parse({
        type: "cli_agent_status_update",
        payload: {
          id: "gemini",
          name: "Gemini",
          status: "connected",
          version: "3.1.0",
          path: "/usr/bin/gemini",
        },
      });
      expect(msg.payload.id).toBe("gemini");
      expect(msg.payload.status).toBe("connected");
    });
  });

  describe("CreateTerminalRequestSchema (extended)", () => {
    test("backward compatible — basic request without command", () => {
      const req = CreateTerminalRequestSchema.parse({
        type: "create_terminal_request",
        cwd: "/home/user/project",
        requestId: "term-1",
      });
      expect(req.command).toBeUndefined();
      expect(req.args).toBeUndefined();
      expect(req.env).toBeUndefined();
    });

    test("accepts command + args for CLI agent", () => {
      const req = CreateTerminalRequestSchema.parse({
        type: "create_terminal_request",
        cwd: "/home/user/project",
        requestId: "term-2",
        name: "Claude Code",
        command: "claude",
        args: ["--dangerously-skip-permissions", "fix the bug"],
        env: { ANTHROPIC_API_KEY: "sk-..." },
      });
      expect(req.command).toBe("claude");
      expect(req.args).toEqual(["--dangerously-skip-permissions", "fix the bug"]);
      expect(req.env).toEqual({ ANTHROPIC_API_KEY: "sk-..." });
    });

    test("old clients without command/args/env still parse", () => {
      // Simulates an old client sending without new fields
      const oldPayload = {
        type: "create_terminal_request",
        cwd: "/tmp",
        requestId: "old-1",
        name: "Terminal 1",
      };
      const req = CreateTerminalRequestSchema.parse(oldPayload);
      expect(req.command).toBeUndefined();
    });
  });
});
