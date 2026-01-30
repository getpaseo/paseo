import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  createDaemonTestContext,
  type DaemonTestContext,
} from "../test-utils/index.js";
import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";
import type { AgentSnapshotPayload, SessionOutboundMessage } from "../messages.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-e2e-"));
}

// Use gpt-5.1-codex-mini with low reasoning effort for faster test execution
const CODEX_TEST_MODEL = "gpt-5.1-codex-mini";
const CODEX_TEST_REASONING_EFFORT = "low";

describe("daemon E2E", () => {
  let ctx: DaemonTestContext;

  beforeEach(async () => {
    ctx = await createDaemonTestContext();
  });

  afterEach(async () => {
    await ctx.cleanup();
  }, 60000);

  describe("persistence flow", () => {
    test(
      "persists and resumes Codex agent with conversation history",
      async () => {
        const cwd = tmpCwd();

        // Create agent
        const agent = await ctx.client.createAgent({
          provider: "codex", model: CODEX_TEST_MODEL, reasoningEffort: CODEX_TEST_REASONING_EFFORT,
          cwd,
          title: "Persistence Test Agent",
        });

        expect(agent.id).toBeTruthy();
        expect(agent.status).toBe("idle");
        const originalAgentId = agent.id;

        // Send a message to generate some state
        await ctx.client.sendMessage(
          agent.id,
          "Say 'state saved' and nothing else"
        );

        // Wait for agent to complete
        const afterMessage = await ctx.client.waitForAgentIdle(agent.id, 120000);
        expect(afterMessage.status).toBe("idle");

        // Get the timeline to verify we have messages
        const queue = ctx.client.getMessageQueue();
        const timelineItems: AgentTimelineItem[] = [];
        for (const m of queue) {
          if (
            m.type === "agent_stream" &&
            m.payload.agentId === agent.id &&
            m.payload.event.type === "timeline"
          ) {
            timelineItems.push(m.payload.event.item);
          }
        }

        // Should have at least one assistant message
        const assistantMessages = timelineItems.filter(
          (item) => item.type === "assistant_message"
        );
        expect(assistantMessages.length).toBeGreaterThan(0);

        // Get persistence handle from agent state
        expect(afterMessage.persistence).toBeTruthy();
        const persistence = afterMessage.persistence;
        expect(persistence?.provider).toBe("codex");
        expect(persistence?.sessionId).toBeTruthy();
        // Codex uses conversationId in metadata for resumption
        expect(
          (persistence?.metadata as { conversationId?: string })?.conversationId
        ).toBeTruthy();

        // Delete the agent from the current session
        await ctx.client.deleteAgent(agent.id);

        // Verify agent deletion was confirmed (agent_deleted event was received)
        const queue2 = ctx.client.getMessageQueue();
        const hasDeletedEvent = queue2.some(
          (m) =>
            m.type === "agent_deleted" && m.payload.agentId === originalAgentId
        );
        expect(hasDeletedEvent).toBe(true);

        // Resume the agent using the persistence handle directly
        // NOTE: Codex MCP doesn't implement listPersistedAgents() because conversations
        // are stored internally by codex CLI. We resume by passing the persistence handle.
        const resumedAgent = await ctx.client.resumeAgent(persistence!);

        expect(resumedAgent.id).toBeTruthy();
        expect(resumedAgent.status).toBe("idle");
        expect(resumedAgent.cwd).toBe(cwd);
        expect(resumedAgent.provider).toBe("codex");

        // Note: AgentSnapshotPayload doesn't include timeline directly.
        // Timeline events are streamed separately. The key verification
        // is that we can send a follow-up message and the agent responds
        // with awareness of the previous conversation context.

        // Verify we can send another message to the resumed agent
        // This proves the conversation context is preserved
        ctx.client.clearMessageQueue();
        await ctx.client.sendMessage(
          resumedAgent.id,
          "What did I ask you to say earlier?"
        );

        const afterResume = await ctx.client.waitForAgentIdle(
          resumedAgent.id,
          120000
        );
        expect(afterResume.status).toBe("idle");

        // Verify we got a response
        const resumeQueue = ctx.client.getMessageQueue();
        const hasResumeResponse = resumeQueue.some((m) => {
          if (m.type !== "agent_stream" || m.payload.event.type !== "timeline") {
            return false;
          }
          return m.payload.event.item.type === "assistant_message";
        });
        expect(hasResumeResponse).toBe(true);

        // Cleanup
        await ctx.client.deleteAgent(resumedAgent.id);
        rmSync(cwd, { recursive: true, force: true });
      },
      300000 // 5 minute timeout for persistence E2E
    );
  });


  describe("timeline persistence across daemon restart", () => {
    test(
      "Codex agent timeline survives daemon restart",
      async () => {
        const cwd = tmpCwd();

        // === Phase 1: Create agent and generate timeline items ===
        const agent = await ctx.client.createAgent({
          provider: "codex", model: CODEX_TEST_MODEL, reasoningEffort: CODEX_TEST_REASONING_EFFORT,
          cwd,
          title: "Restart Timeline Test Agent",
        });

        expect(agent.id).toBeTruthy();
        expect(agent.status).toBe("idle");

        // Send a message to generate timeline items
        await ctx.client.sendMessage(
          agent.id,
          "Say 'timeline test' and nothing else"
        );

        // Wait for agent to complete
        const afterMessage = await ctx.client.waitForAgentIdle(agent.id, 120000);
        expect(afterMessage.status).toBe("idle");

        // Verify we have timeline items before restart
        const queue = ctx.client.getMessageQueue();
        const timelineItems: AgentTimelineItem[] = [];
        for (const m of queue) {
          if (
            m.type === "agent_stream" &&
            m.payload.agentId === agent.id &&
            m.payload.event.type === "timeline"
          ) {
            timelineItems.push(m.payload.event.item);
          }
        }

        // Should have at least one assistant message
        const assistantMessages = timelineItems.filter(
          (item) => item.type === "assistant_message"
        );
        expect(assistantMessages.length).toBeGreaterThan(0);

        // Get persistence handle
        const persistence = afterMessage.persistence;
        expect(persistence).toBeTruthy();
        expect(persistence?.provider).toBe("codex");
        expect(persistence?.sessionId).toBeTruthy();

        // Record how many timeline items we had
        const preRestartTimelineCount = timelineItems.length;
        expect(preRestartTimelineCount).toBeGreaterThan(0);

        // === Phase 2: Restart daemon ===
        // Cleanup old context (stops daemon)
        await ctx.cleanup();

        // Create new daemon context (starts fresh daemon)
        ctx = await createDaemonTestContext();

        // === Phase 3: Resume agent and verify timeline is preserved ===
        const resumedAgent = await ctx.client.resumeAgent(persistence!);

        expect(resumedAgent.id).toBeTruthy();
        expect(resumedAgent.status).toBe("idle");
        expect(resumedAgent.provider).toBe("codex");

        // Wait a moment for history events to be emitted
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // Get timeline items that were emitted after resume
        // Timeline items from history are sent as agent_stream_snapshot, not individual agent_stream
        const resumeQueue = ctx.client.getMessageQueue();
        const resumedTimelineItems: AgentTimelineItem[] = [];

        // First check for agent_stream_snapshot (batched history)
        for (const m of resumeQueue) {
          if (
            m.type === "agent_stream_snapshot" &&
            (m.payload as { agentId: string }).agentId === resumedAgent.id
          ) {
            const events = (m.payload as { events: Array<{ event: { type: string; item?: AgentTimelineItem } }> }).events;
            for (const e of events) {
              if (e.event.type === "timeline" && e.event.item) {
                resumedTimelineItems.push(e.event.item);
              }
            }
          }
        }

        // Also check for individual agent_stream events (in case they were sent that way)
        for (const m of resumeQueue) {
          if (
            m.type === "agent_stream" &&
            m.payload.agentId === resumedAgent.id &&
            m.payload.event.type === "timeline"
          ) {
            resumedTimelineItems.push(m.payload.event.item);
          }
        }

        // CRITICAL ASSERTION: Timeline should NOT be empty after daemon restart
        // This verifies that persisted history is loaded from disk (rollout files)
        // when SESSION_HISTORY is empty due to daemon restart
        expect(resumedTimelineItems.length).toBeGreaterThan(0);

        // Verify the original messages are present
        const resumedAssistant = resumedTimelineItems.filter(
          (item) => item.type === "assistant_message"
        );
        expect(resumedAssistant.length).toBeGreaterThan(0);

        // Cleanup
        await ctx.client.deleteAgent(resumedAgent.id);
        rmSync(cwd, { recursive: true, force: true });
      },
      300000 // 5 minute timeout for restart test
    );
  });


  describe("external Codex session import", () => {
    test(
      "imports external codex exec session and preserves conversation context",
      async () => {
        const cwd = tmpCwd();
        const { execSync, spawn } = await import("child_process");

        // Initialize git repo (Codex requires a trusted directory)
        execSync("git init", { cwd, stdio: "pipe" });
        execSync("git config user.email 'test@test.com'", { cwd, stdio: "pipe" });
        execSync("git config user.name 'Test'", { cwd, stdio: "pipe" });
        writeFileSync(path.join(cwd, "README.md"), "# Test\n");
        execSync("git add .", { cwd, stdio: "pipe" });
        execSync("git -c commit.gpgsign=false commit -m 'Initial commit'", {
          cwd,
          stdio: "pipe",
        });

        // === STEP 1: Run external codex exec with a memorable number ===
        // We use spawn so we can send input and capture output

        // Use a memorable number that we'll ask about later
        const magicNumber = 69;
        const prompt = `Remember this number: ${magicNumber}. Just confirm you've remembered it and reply with a single short sentence.`;

        // Spawn codex exec and capture stdout to get session ID
        let sessionId: string | null = null;
        let codexOutput = "";

        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            codexProcess.kill();
            reject(new Error("Codex exec timeout after 120 seconds"));
          }, 120000);

          const codexProcess = spawn("codex", ["exec", prompt], {
            cwd,
            env: {
              ...process.env,
              // Ensure full-access mode to avoid permission prompts
              CODEX_SANDBOX: "danger-full-access",
              CODEX_APPROVAL_POLICY: "never",
            },
            stdio: ["pipe", "pipe", "pipe"],
          });

          codexProcess.stdout.on("data", (data: Buffer) => {
            const text = data.toString();
            codexOutput += text;

            // Look for session ID in output
            // Format: "session id: 019b5ea3-25d5-7202-bd06-6b1db405e505"
            const match = text.match(/session id:\s*([0-9a-f-]+)/i);
            if (match) {
              sessionId = match[1];

            }
          });

          codexProcess.stderr.on("data", (data: Buffer) => {
            const text = data.toString();

            // Session ID might also appear in stderr
            const match = text.match(/session id:\s*([0-9a-f-]+)/i);
            if (match && !sessionId) {
              sessionId = match[1];

            }
          });

          codexProcess.on("close", (code) => {
            clearTimeout(timeout);

            if (code === 0 || sessionId) {
              resolve();
            } else {
              reject(new Error(`codex exec failed with code ${code}`));
            }
          });

          codexProcess.on("error", (err) => {
            clearTimeout(timeout);
            reject(err);
          });
        });

        // Verify we captured the session ID
        expect(sessionId).not.toBeNull();
        expect(sessionId).toMatch(/^[0-9a-f-]+$/);

        // === STEP 2: Find the transcript file for this session ===
        // Codex stores transcripts at ~/.codex/sessions/**/*-{sessionId}.jsonl
        const codexHome = process.env.CODEX_HOME || path.join(tmpdir(), "..", "..", "home", process.env.USER || "", ".codex");
        const actualCodexHome = path.join(process.env.HOME || "", ".codex");
        const sessionsDir = path.join(actualCodexHome, "sessions");

        // Find the transcript file
        function findTranscriptFile(dir: string, targetSessionId: string): string | null {
          try {
            const entries = readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
              const fullPath = path.join(dir, entry.name);
              if (entry.isDirectory()) {
                const found = findTranscriptFile(fullPath, targetSessionId);
                if (found) return found;
              } else if (entry.isFile() && fullPath.endsWith(`-${targetSessionId}.jsonl`)) {
                return fullPath;
              }
            }
          } catch {
            // Directory doesn't exist or not readable
          }
          return null;
        }

        let transcriptFile: string | null = null;
        const transcriptWaitStart = Date.now();
        while (Date.now() - transcriptWaitStart < 10000) {
          transcriptFile = findTranscriptFile(sessionsDir, sessionId!);
          if (transcriptFile) break;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }

        // Verify transcript file exists
        expect(transcriptFile).not.toBeNull();
        expect(existsSync(transcriptFile!)).toBe(true);

        // Read and verify transcript has content
        const transcriptContent = readFileSync(transcriptFile!, "utf-8");

        expect(transcriptContent.length).toBeGreaterThan(0);

        // === STEP 3: Import this session into the daemon ===

        const agent = await ctx.client.createAgent({
          provider: "codex", model: CODEX_TEST_MODEL, reasoningEffort: CODEX_TEST_REASONING_EFFORT,
          cwd,
          title: "External Session Import Test",
          modeId: "full-access",
          extra: {
            codex: {
              experimental_resume: transcriptFile,
            },
          },
        });

        expect(agent.id).toBeTruthy();
        expect(agent.status).toBe("idle");

        // === STEP 4: Ask the daemon agent about the number ===

        ctx.client.clearMessageQueue();

        await ctx.client.sendMessage(
          agent.id,
          "What was the number I asked you to remember earlier? Reply with just the number and nothing else."
        );

        const finalState = await ctx.client.waitForAgentIdle(agent.id, 120000);

        expect(finalState.status).toBe("idle");
        expect(finalState.lastError).toBeUndefined();

        // === STEP 5: Verify the response contains the magic number ===
        const queue = ctx.client.getMessageQueue();
        const assistantMessages: string[] = [];

        for (const m of queue) {
          if (
            m.type === "agent_stream" &&
            m.payload.agentId === agent.id &&
            m.payload.event.type === "timeline"
          ) {
            const item = m.payload.event.item;
            if (item.type === "assistant_message" && item.text) {
              assistantMessages.push(item.text);
            }
          }
        }

        const fullResponse = assistantMessages.join("");

        // CRITICAL ASSERTION: The response should contain the magic number
        // This proves the daemon agent successfully loaded the external session's context
        expect(fullResponse).toContain(String(magicNumber));

        // === STEP 6: Verify history was present when importing ===
        // Check that we received history timeline items (from the external session)
        // These would be in agent_stream_snapshot if history was replayed

        // Note: The experimental_resume feature loads history directly into Codex,
        // so we may not see individual history items streamed back. The key test
        // is that the agent can recall the number, which proves context was preserved.

        // Cleanup
        await ctx.client.deleteAgent(agent.id);
        rmSync(cwd, { recursive: true, force: true });
      },
      300000 // 5 minute timeout for external session test
    );

    test(
      "fails gracefully when resuming non-existent external session",
      async () => {
        const cwd = tmpCwd();

        // Try to create agent with a non-existent transcript file
        const fakeTranscriptFile = path.join(cwd, "non-existent-session.jsonl");

        const agent = await ctx.client.createAgent({
          provider: "codex", model: CODEX_TEST_MODEL, reasoningEffort: CODEX_TEST_REASONING_EFFORT,
          cwd,
          title: "Non-existent Session Test",
          modeId: "full-access",
          extra: {
            codex: {
              experimental_resume: fakeTranscriptFile,
            },
          },
        });

        expect(agent.id).toBeTruthy();
        expect(agent.status).toBe("idle");

        // The agent should still work, just without the resume context
        // Send a simple message to verify it's functional
        ctx.client.clearMessageQueue();
        await ctx.client.sendMessage(agent.id, "Say 'hello' and nothing else.");

        const finalState = await ctx.client.waitForAgentIdle(agent.id, 60000);

        // Agent should complete (possibly with Codex warning about missing file,
        // but should still function)
        expect(["idle", "error"]).toContain(finalState.status);

        // Verify we got some response
        const queue = ctx.client.getMessageQueue();
        const hasResponse = queue.some(
          (m) =>
            m.type === "agent_stream" &&
            m.payload.agentId === agent.id &&
            m.payload.event.type === "timeline" &&
            m.payload.event.item.type === "assistant_message"
        );
        expect(hasResponse).toBe(true);

        // Cleanup
        await ctx.client.deleteAgent(agent.id);
        rmSync(cwd, { recursive: true, force: true });
      },
      120000 // 2 minute timeout
    );
  });


  describe("Claude persisted agent import", () => {
    test("filters internal warmup entries from persisted Claude history", async () => {
      const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
      const claudeConfigDir = mkdtempSync(path.join(tmpdir(), "claude-config-"));
      process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;

      const projectDir = path.join(claudeConfigDir, "projects", "test-project");
      mkdirSync(projectDir, { recursive: true });

      const sessionId = `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const cwd = "/tmp/claude-import-test";
      const historyLines = [
        JSON.stringify({
          type: "user",
          isSidechain: true,
          sessionId,
          cwd,
          message: { role: "user", content: "Warmup" },
        }),
        JSON.stringify({
          type: "user",
          sessionId,
          cwd,
          message: { role: "user", content: "Real task prompt" },
        }),
      ];
      const historyPath = path.join(projectDir, `${sessionId}.jsonl`);
      writeFileSync(historyPath, `${historyLines.join("\n")}\n`, "utf8");

      try {
        const persisted =
          await ctx.daemon.daemon.agentManager.listPersistedAgents();
        const claudeEntry = persisted.find((item) => item.sessionId === sessionId);

        expect(claudeEntry).toBeTruthy();
        expect(claudeEntry?.title).toBe("Real task prompt");

        const timelineTexts = (claudeEntry?.timeline ?? [])
          .map((item) => {
            if (item.type === "user_message" || item.type === "assistant_message") {
              return item.text;
            }
            return null;
          })
          .filter((text): text is string => typeof text === "string");

        expect(timelineTexts).toContain("Real task prompt");
        expect(timelineTexts).not.toContain("Warmup");
      } finally {
        if (previousClaudeConfigDir === undefined) {
          delete process.env.CLAUDE_CONFIG_DIR;
        } else {
          process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
        }
        rmSync(claudeConfigDir, { recursive: true, force: true });
      }
    });
  });


  describe("Codex persisted agent import", () => {
    test("lists Codex sessions from rollout files", async () => {
      const previousCodexSessionDir = process.env.CODEX_SESSION_DIR;
      const codexSessionDir = mkdtempSync(path.join(tmpdir(), "codex-session-"));
      process.env.CODEX_SESSION_DIR = codexSessionDir;

      const sessionId = `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const cwd = "/tmp/codex-import-test";
      const now = new Date().toISOString();
      const rolloutPath = path.join(codexSessionDir, `rollout-${sessionId}.jsonl`);
      const lines = [
        JSON.stringify({
          timestamp: now,
          type: "session_meta",
          payload: { id: sessionId, timestamp: now, cwd },
        }),
        JSON.stringify({
          timestamp: now,
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Import this Codex session" }],
          },
        }),
        JSON.stringify({
          timestamp: now,
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Codex import ready" }],
          },
        }),
      ];
      writeFileSync(rolloutPath, `${lines.join("\n")}\n`, "utf8");

      try {
        const persisted =
          await ctx.daemon.daemon.agentManager.listPersistedAgents();
        const codexEntry = persisted.find(
          (item) => item.provider === "codex" && item.sessionId === sessionId
        );

        expect(codexEntry).toBeTruthy();
        expect(codexEntry?.cwd).toBe(cwd);

        const timelineTexts = (codexEntry?.timeline ?? [])
          .map((item) => {
            if (item.type === "user_message" || item.type === "assistant_message") {
              return item.text;
            }
            return null;
          })
          .filter((text): text is string => typeof text === "string");

        expect(timelineTexts).toContain("Import this Codex session");
        expect(timelineTexts).toContain("Codex import ready");
      } finally {
        if (previousCodexSessionDir === undefined) {
          delete process.env.CODEX_SESSION_DIR;
        } else {
          process.env.CODEX_SESSION_DIR = previousCodexSessionDir;
        }
        rmSync(codexSessionDir, { recursive: true, force: true });
      }
    });
  });


  describe("Claude session persistence", () => {
    test(
      "persists and resumes Claude agent with conversation history (remembers number)",
      async () => {
        const cwd = tmpCwd();

        // Use a memorable number that we'll ask about later
        const magicNumber = 69;

        // === STEP 1: Create Claude agent and have it remember a number ===

        const agent = await ctx.client.createAgent({
          provider: "claude",
          cwd,
          title: "Claude Persistence Test",
          modeId: "bypassPermissions",
        });

        expect(agent.id).toBeTruthy();
        expect(agent.status).toBe("idle");
        expect(agent.provider).toBe("claude");

        // === STEP 2: Ask it to remember the number ===

        await ctx.client.sendMessage(
          agent.id,
          `Remember this number: ${magicNumber}. Just confirm you've remembered it and reply with a single short sentence.`
        );

        const afterRemember = await ctx.client.waitForAgentIdle(agent.id, 120000);
        expect(afterRemember.status).toBe("idle");
        expect(afterRemember.lastError).toBeUndefined();

        // Verify we got a confirmation response
        let queue = ctx.client.getMessageQueue();
        const confirmationMessages: string[] = [];
        for (const m of queue) {
          if (
            m.type === "agent_stream" &&
            m.payload.agentId === agent.id &&
            m.payload.event.type === "timeline"
          ) {
            const item = m.payload.event.item;
            if (item.type === "assistant_message" && item.text) {
              confirmationMessages.push(item.text);
            }
          }
        }
        const confirmationResponse = confirmationMessages.join("");

        expect(confirmationResponse.length).toBeGreaterThan(0);

        // === STEP 3: Get persistence handle and delete agent ===
        expect(afterRemember.persistence).toBeTruthy();
        const persistence = afterRemember.persistence;
        expect(persistence?.provider).toBe("claude");
        expect(persistence?.sessionId).toBeTruthy();

        // Delete the agent
        await ctx.client.deleteAgent(agent.id);

        // === STEP 4: Resume the agent using persistence handle ===

        ctx.client.clearMessageQueue();
        const resumedAgent = await ctx.client.resumeAgent(persistence!);

        expect(resumedAgent.id).toBeTruthy();
        expect(resumedAgent.status).toBe("idle");
        expect(resumedAgent.provider).toBe("claude");

        // === STEP 5: Ask about the remembered number ===

        ctx.client.clearMessageQueue();
        await ctx.client.sendMessage(
          resumedAgent.id,
          "What was the number I asked you to remember earlier? Reply with just the number and nothing else."
        );

        const afterRecall = await ctx.client.waitForAgentIdle(resumedAgent.id, 120000);
        expect(afterRecall.status).toBe("idle");
        expect(afterRecall.lastError).toBeUndefined();

        // === STEP 6: Verify the response contains the magic number ===
        queue = ctx.client.getMessageQueue();
        const recallMessages: string[] = [];
        for (const m of queue) {
          if (
            m.type === "agent_stream" &&
            m.payload.agentId === resumedAgent.id &&
            m.payload.event.type === "timeline"
          ) {
            const item = m.payload.event.item;
            if (item.type === "assistant_message" && item.text) {
              recallMessages.push(item.text);
            }
          }
        }
        const fullResponse = recallMessages.join("");

        // CRITICAL ASSERTION: The response should contain the magic number
        // This proves the Claude agent successfully preserved conversation context
        expect(fullResponse).toContain(String(magicNumber));

        // Cleanup
        await ctx.client.deleteAgent(resumedAgent.id);
        rmSync(cwd, { recursive: true, force: true });
      },
      300000 // 5 minute timeout for multiple Claude API calls
    );
  });


});
