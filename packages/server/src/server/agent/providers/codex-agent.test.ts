import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { CodexAgentClient } from "./codex-agent.js";
import type { AgentSessionConfig, AgentStreamEvent, AgentPermissionRequest } from "../agent-sdk-types.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(os.tmpdir(), "codex-agent-e2e-"));
}

function useTempCodexSessionDir(): () => void {
  const prevSessionDir = process.env.CODEX_SESSION_DIR;
  const prevHome = process.env.CODEX_HOME;
  return () => {
    if (prevSessionDir === undefined) {
      delete process.env.CODEX_SESSION_DIR;
    } else {
      process.env.CODEX_SESSION_DIR = prevSessionDir;
    }
    if (prevHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = prevHome;
    }
  };
}

function log(message: string): void {
  console.info(`[CodexAgentTest] ${message}`);
}

function createStubCodexBinary(events: Record<string, unknown>[]): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "codex-stub-"));
  const filePath = path.join(dir, "codex-stub.js");
  const script = `#!/usr/bin/env node
const events = ${JSON.stringify(events)};
const emit = () => {
  for (const event of events) {
    process.stdout.write(JSON.stringify(event) + "\\n");
  }
};

if (process.stdin.isTTY) {
  emit();
  process.exit(0);
} else {
  process.stdin.resume();
  process.stdin.on("data", () => {});
  process.stdin.on("end", () => {
    emit();
    process.exit(0);
  });
}`;
  writeFileSync(filePath, script, "utf8");
  chmodSync(filePath, 0o755);
  return {
    path: filePath,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("CodexAgentClient (SDK integration)", () => {
  test(
    "responds with text",
    async () => {
      const cwd = tmpCwd();
      const restoreSessionDir = useTempCodexSessionDir();
      const client = new CodexAgentClient();
      const config: AgentSessionConfig = { provider: "codex", cwd, modeId: "full-access" };
      let session: Awaited<ReturnType<typeof client.createSession>> | null = null;
      try {
        session = await client.createSession(config);
        log("Running single-turn acknowledgment test");

        const result = await session.run("Reply with the single word ACK and then stop.");

        expect(result.finalText.toLowerCase()).toContain("ack");
      } finally {
        await session?.close();
        rmSync(cwd, { recursive: true, force: true });
        restoreSessionDir();
      }
    },
    120_000
  );

  test(
    "emits tool or command events when writing a file",
    async () => {
      const cwd = tmpCwd();
      const restoreSessionDir = useTempCodexSessionDir();
      const client = new CodexAgentClient();
      const config: AgentSessionConfig = { provider: "codex", cwd };
      let session: Awaited<ReturnType<typeof client.createSession>> | null = null;
      try {
        session = await client.createSession(config);
        log("Streaming file creation activity");

        const events = session.stream(
          "Create a file named tool-test.txt in the current directory with the contents 'hello world', then stop."
        );

        let sawActivity = false;

        for await (const event of events) {
          if (
            event.type === "timeline" &&
            event.provider === "codex" &&
            (event.item.type === "file_change" || event.item.type === "command" || event.item.type === "mcp_tool")
          ) {
            sawActivity = true;
          }
          if (
            event.type === "provider_event" &&
            event.provider === "codex" &&
            event.raw?.type &&
            event.raw.type.startsWith("item") &&
            ["file_change", "command_execution", "mcp_tool_call"].includes((event.raw as any).item?.type)
          ) {
            sawActivity = true;
          }

          if (event.type === "turn_completed" || event.type === "turn_failed") {
            break;
          }
        }

        expect(sawActivity).toBe(true);
      } finally {
        await session?.close();
        rmSync(cwd, { recursive: true, force: true });
        restoreSessionDir();
      }
    },
    180_000
  );

  test(
    "supports multiple turns within the same session",
    async () => {
      const cwd = tmpCwd();
      const restoreSessionDir = useTempCodexSessionDir();
      const client = new CodexAgentClient();
      const config: AgentSessionConfig = { provider: "codex", cwd };
      let session: Awaited<ReturnType<typeof client.createSession>> | null = null;
      try {
        session = await client.createSession(config);
        log("Running multi-turn continuity test");

        const first = await session.run("Reply with the exact text ACK-ONE and then stop.");
        expect(first.finalText.toLowerCase()).toContain("ack-one");

        const handleAfterFirst = session.describePersistence();
        expect(handleAfterFirst?.sessionId).toBeTruthy();

        const second = await session.run("Now reply with another acknowledgment and then stop.");
        expect(second.finalText).not.toHaveLength(0);
        expect(second.finalText).not.toBe(first.finalText);

        const handleAfterSecond = session.describePersistence();
        expect(handleAfterSecond?.sessionId).toBe(handleAfterFirst?.sessionId);
      } finally {
        await session?.close();
        rmSync(cwd, { recursive: true, force: true });
        restoreSessionDir();
      }
    },
    150_000
  );

  test(
    "can change modes mid-session",
    async () => {
      const cwd = tmpCwd();
      const restoreSessionDir = useTempCodexSessionDir();
      const client = new CodexAgentClient();
      const config: AgentSessionConfig = { provider: "codex", cwd, modeId: "auto" };
      let session: Awaited<ReturnType<typeof client.createSession>> | null = null;
      try {
        session = await client.createSession(config);
        log("Testing mode transitions inside a single session");

        expect(await session.getCurrentMode()).toBe("auto");

        const first = await session.run("Reply with ACK-MODE-AUTO and then stop.");
        expect(first.finalText.toLowerCase()).toContain("ack-mode-auto");

        await session.setMode("full-access");
        expect(await session.getCurrentMode()).toBe("full-access");

        const second = await session.run("Reply with ACK-MODE-FULL and then stop.");
        expect(second.finalText.toLowerCase()).toContain("ack-mode-full");
      } finally {
        await session?.close();
        rmSync(cwd, { recursive: true, force: true });
        restoreSessionDir();
      }
    },
    180_000
  );

  test(
    "resumes a session using a persistence handle",
    async () => {
      const cwd = tmpCwd();
      const restoreSessionDir = useTempCodexSessionDir();
      const client = new CodexAgentClient();
      const config: AgentSessionConfig = { provider: "codex", cwd };
      let session: Awaited<ReturnType<typeof client.createSession>> | null = null;
      let resumed: Awaited<ReturnType<typeof client.resumeSession>> | null = null;
      try {
        session = await client.createSession(config);
        log("Recording initial turn before persistence");

        await session.run("Remember the word ALPHA and confirm with ACK.");
        const handle = session.describePersistence();
        expect(handle).not.toBeNull();
        expect(handle?.sessionId).toBeTruthy();

        await session.close();
        session = null;

        log("Resuming session from persistence handle");
        resumed = await client.resumeSession(handle!);
        const replayedHistory: AgentStreamEvent[] = [];
        for await (const event of resumed.streamHistory()) {
          replayedHistory.push(event);
        }
        log(
          `Replayed ${replayedHistory.length} history events: ${JSON.stringify(
            replayedHistory.map((e) => ({ type: e.type, timelineType: e.type === "timeline" ? e.item.type : undefined })),
            null,
            2
          )}`
        );
        expect(
          replayedHistory.some(
            (event) =>
              event.type === "timeline" && event.provider === "codex" && event.item.type === "assistant_message"
          )
        ).toBe(true);

        const response = await resumed.run("Respond with ACK-RESUMED and then stop.");
        expect(response.finalText.toLowerCase()).toContain("ack-resumed");

        const resumedHandle = resumed.describePersistence();
        expect(resumedHandle?.sessionId).toBe(handle?.sessionId);
      } finally {
        await session?.close();
        await resumed?.close();
        rmSync(cwd, { recursive: true, force: true });
        restoreSessionDir();
      }
    },
    180_000
  );

  test(
    "emits permission requests and resolves them when approvals are handled",
    async () => {
      const cwd = tmpCwd();
      const restoreSessionDir = useTempCodexSessionDir();
      const events = [
        { type: "thread.started", thread_id: "019a83a2-permission" },
        { type: "turn.started" },
        {
          type: "exec_approval_request",
          call_id: "call-permission-1",
          command: ["bash", "-lc", "rm -rf /tmp/codex"],
          cwd,
          reason: "Requires elevated sandbox permissions",
          risk: { description: "Deletes files", risk_level: "high" },
        },
        { type: "turn.failed", error: { message: "Approval required" } },
      ];
      const stub = createStubCodexBinary(events);
      const client = new CodexAgentClient({ codexPathOverride: stub.path });
      const config: AgentSessionConfig = { provider: "codex", cwd };
      let session: Awaited<ReturnType<typeof client.createSession>> | null = null;
      try {
        session = await client.createSession(config);
        log("Processing synthetic permission request stream");

        let captured: AgentPermissionRequest | null = null;
        const streamed = session.stream("Trigger permission request");
        for await (const event of streamed) {
          if (event.type === "permission_requested") {
            captured = event.request;
          }
          if (event.type === "turn_failed") {
            break;
          }
        }

        expect(captured).not.toBeNull();
        expect(session.getPendingPermissions()).toHaveLength(1);

        await session.respondToPermission(captured!.id, { behavior: "allow" });

        const replay: AgentStreamEvent[] = [];
        for await (const event of session.streamHistory()) {
          replay.push(event);
        }

        expect(
          replay.some(
            (event) =>
              event.type === "permission_resolved" &&
              event.requestId === captured!.id &&
              event.resolution.behavior === "allow"
          )
        ).toBe(true);
        expect(session.getPendingPermissions()).toHaveLength(0);
      } finally {
        await session?.close();
        stub.cleanup();
        rmSync(cwd, { recursive: true, force: true });
        restoreSessionDir();
      }
    },
    30_000
  );
});
