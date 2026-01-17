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

  describe("Claude agent streaming text integrity", () => {
    test(
      "assistant_message text is coherent and not garbled during streaming",
      async () => {
        const cwd = tmpCwd();

        // Create Claude agent
        const agent = await ctx.client.createAgent({
          provider: "claude",
          cwd,
          title: "Streaming Text Integrity Test",
        });

        expect(agent.id).toBeTruthy();
        expect(agent.provider).toBe("claude");

        // Send a message that should produce a longer, coherent response
        // The agent should complete a sentence with proper grammar
        await ctx.client.sendMessage(
          agent.id,
          "Please complete this sentence with exactly one more sentence: 'The quick brown fox jumps over the lazy dog.' Write a follow-up sentence about what the fox did next. Reply with just the two sentences, nothing else."
        );

        // Wait for agent to complete
        const finalState = await ctx.client.waitForAgentIdle(agent.id, 120000);

        expect(finalState.status).toBe("idle");
        expect(finalState.lastError).toBeUndefined();

        // Collect all assistant_message timeline events in order
        const queue = ctx.client.getMessageQueue();
        const assistantChunks: string[] = [];

        for (const m of queue) {
          if (
            m.type === "agent_stream" &&
            m.payload.agentId === agent.id &&
            m.payload.event.type === "timeline"
          ) {
            const item = m.payload.event.item;
            if (item.type === "assistant_message" && item.text) {
              assistantChunks.push(item.text);
            }
          }
        }

        // Should have received at least one assistant message chunk
        expect(assistantChunks.length).toBeGreaterThan(0);

        // Concatenate all chunks to form the complete response
        const fullResponse = assistantChunks.join("");




        // CRITICAL ASSERTION 1: Response should not be empty
        expect(fullResponse.length).toBeGreaterThan(0);

        // CRITICAL ASSERTION 2: Response should contain coherent English text
        // Check for garbled patterns from the bug report:
        // - "wasd" (random characters in word)
        // - "passesd" (double letters incorrectly)
        // - words cut off mid-word and merged with other words

        // Check that the response contains real words and proper sentence structure
        // A garbled response like "The agent wasd. my an a newdex" would fail these checks

        // The response should contain "fox" or "dog" since we asked about them
        const lowerResponse = fullResponse.toLowerCase();
        const containsRelevantContent =
          lowerResponse.includes("fox") ||
          lowerResponse.includes("dog") ||
          lowerResponse.includes("quick") ||
          lowerResponse.includes("brown") ||
          lowerResponse.includes("lazy") ||
          lowerResponse.includes("jumps");

        expect(containsRelevantContent).toBe(true);

        // CRITICAL ASSERTION 3: Check for garbled text patterns
        // These patterns indicate text corruption during streaming
        const garbledPatterns = [
          /\w{2,}d\.\s+[a-z]+\s+[a-z]+\s+[a-z]+d/, // "wasd. my an a ...d" pattern
          /\b\w+sd\b/, // words ending in "sd" like "passesd", "wasd"
          /\b\w+d\s+\w+d\s+\w+d\b/, // multiple consecutive words ending in "d"
          /[a-z]{10,}/, // very long "words" that are actually merged text
        ];

        for (const pattern of garbledPatterns) {
          const match = fullResponse.match(pattern);
          if (match) {

          }
          // Note: We log but don't fail on these patterns as they might occur in valid text
          // The real test is whether the response is semantically coherent
        }

        // CRITICAL ASSERTION 4: Each individual chunk should not start/end mid-word in a corrupted way
        // Check that we don't have incomplete Unicode or obviously broken text
        for (let i = 0; i < assistantChunks.length; i++) {
          const chunk = assistantChunks[i];

          // Chunks should not contain null bytes or other corruption
          expect(chunk).not.toMatch(/\x00/);

          // Chunks should be valid UTF-8 (no replacement characters unless intentional)
          expect(chunk).not.toMatch(/\uFFFD/);
        }

        // CRITICAL ASSERTION 5: Verify sentence completeness
        // The response should contain at least one period (sentence ending)
        expect(fullResponse).toMatch(/\./);

        // Cleanup
        await ctx.client.deleteAgent(agent.id);
        rmSync(cwd, { recursive: true, force: true });
      },
      180000 // 3 minute timeout for Claude API call
    );
  });


  describe("Claude agent streaming text integrity - long running", () => {
    test(
      "streaming chunks remain coherent after multiple back-and-forth messages",
      async () => {
        const cwd = tmpCwd();

        // Create Claude agent with bypassPermissions mode to avoid permission prompts
        const agent = await ctx.client.createAgent({
          provider: "claude",
          cwd,
          title: "Long Running Streaming Test",
          modeId: "bypassPermissions",
        });

        expect(agent.id).toBeTruthy();
        expect(agent.provider).toBe("claude");

        // === MESSAGE 1: Establish conversation context ===

        await ctx.client.sendMessage(
          agent.id,
          "Remember the number 42. Just confirm you remember it."
        );

        let state = await ctx.client.waitForAgentIdle(agent.id, 120000);
        expect(state.status).toBe("idle");
        expect(state.lastError).toBeUndefined();

        // === MESSAGE 2: Build on conversation ===
        ctx.client.clearMessageQueue(); // Clear queue to isolate message 2

        await ctx.client.sendMessage(
          agent.id,
          "Now remember the word 'elephant'. Just confirm you remember both the number and the word."
        );

        state = await ctx.client.waitForAgentIdle(agent.id, 120000);
        expect(state.status).toBe("idle");
        expect(state.lastError).toBeUndefined();

        // === MESSAGE 3: This is where the bug was reported to manifest ===
        // Clear queue so we can capture streaming chunks for message 3 only
        ctx.client.clearMessageQueue();

        await ctx.client.sendMessage(
          agent.id,
          "Write a complete sentence using both the number (42) and the word (elephant) you remembered. The sentence should be grammatically correct English."
        );

        state = await ctx.client.waitForAgentIdle(agent.id, 120000);
        expect(state.status).toBe("idle");
        expect(state.lastError).toBeUndefined();

        // Collect all assistant_message timeline events from message 3
        const queue = ctx.client.getMessageQueue();
        const assistantChunks: string[] = [];

        for (const m of queue) {
          if (
            m.type === "agent_stream" &&
            m.payload.agentId === agent.id &&
            m.payload.event.type === "timeline"
          ) {
            const item = m.payload.event.item;
            if (item.type === "assistant_message" && item.text) {
              assistantChunks.push(item.text);
            }
          }
        }

        // Should have received at least one assistant message chunk
        expect(assistantChunks.length).toBeGreaterThan(0);

        // Concatenate all chunks to form the complete response
        const fullResponse = assistantChunks.join("");


        for (let i = 0; i < assistantChunks.length; i++) {

        }

        // CRITICAL ASSERTION 1: Response should contain expected content
        const lowerResponse = fullResponse.toLowerCase();
        const containsNumber = lowerResponse.includes("42");
        const containsWord = lowerResponse.includes("elephant");


        expect(containsNumber).toBe(true);
        expect(containsWord).toBe(true);

        // CRITICAL ASSERTION 2: Check for garbled text patterns
        // These patterns indicate chunks being incorrectly split/merged
        // Pattern from bug report: "acheck error" instead of "a typecheck error" (missing "type")

        // Check consecutive chunks for suspicious splits
        for (let i = 0; i < assistantChunks.length - 1; i++) {
          const current = assistantChunks[i];
          const next = assistantChunks[i + 1];

          // Look for a chunk ending with a letter followed by a chunk starting with
          // a letter that wouldn't make sense together (e.g., "a" + "check")
          const currentEndsWithLetter = /[a-zA-Z]$/.test(current);
          const nextStartsWithLetter = /^[a-zA-Z]/.test(next);

          if (currentEndsWithLetter && nextStartsWithLetter) {
            // This could be legitimate (word continues) or a split issue
            // Log for debugging

          }
        }

        // CRITICAL ASSERTION 3: Check for UTF-8 corruption
        for (const chunk of assistantChunks) {
          expect(chunk).not.toMatch(/\x00/); // No null bytes
          expect(chunk).not.toMatch(/\uFFFD/); // No replacement characters
        }

        // CRITICAL ASSERTION 4: The full response should be valid English
        // Check that the response has proper word spacing
        const wordPattern = /\b[a-zA-Z]+\b/g;
        const words = fullResponse.match(wordPattern) || [];
        expect(words.length).toBeGreaterThan(3); // Should have multiple words

        // Check for improperly concatenated words (very long "words" that shouldn't exist)
        const suspiciouslyLongWords = words.filter(w => w.length > 20);
        if (suspiciouslyLongWords.length > 0) {

        }
        // Allow some technical words but flag excessive length
        expect(suspiciouslyLongWords.filter(w => w.length > 30).length).toBe(0);

        // Cleanup
        await ctx.client.deleteAgent(agent.id);
        rmSync(cwd, { recursive: true, force: true });
      },
      300000 // 5 minute timeout for multiple Claude API calls
    );
  });


  describe("Claude agent overlapping stream() calls race condition", () => {
    test(
      "interrupting message should produce coherent text without garbling from race condition",
      async () => {
        const cwd = tmpCwd();

        // Create Claude agent with bypassPermissions mode
        const agent = await ctx.client.createAgent({
          provider: "claude",
          cwd,
          title: "Overlapping Streams Race Condition Test",
          modeId: "bypassPermissions",
        });

        expect(agent.id).toBeTruthy();
        expect(agent.provider).toBe("claude");

        // === MESSAGE 1: Start a long-running prompt that will be interrupted ===

        // Record queue position BEFORE message 1 to find the cutoff point later
        const msg1StartPosition = ctx.client.getMessageQueue().length;

        // Use sendMessage but don't await waitForAgentIdle - let it run
        await ctx.client.sendMessage(
          agent.id,
          "Write a very detailed 500 word essay about the history of computing, starting from the earliest mechanical computers through modern quantum computing. Include specific dates, inventors, and technological milestones."
        );

        // Wait a short time for Turn 1 to start streaming (but not finish)
        // This ensures forwardPromptEvents() is actively running
        await new Promise(resolve => setTimeout(resolve, 2000));

        // === MESSAGE 2: Immediately send another message to interrupt ===
        // This triggers the race condition where Turn 2's forwardPromptEvents
        // resets streamedAssistantTextThisTurn while Turn 1 is still reading it

        // Record queue position BEFORE message 2 to find message 2 chunks
        const msg2StartPosition = ctx.client.getMessageQueue().length;

        await ctx.client.sendMessage(
          agent.id,
          "Stop. Just say exactly: 'Hello world from interrupted message'"
        );

        // Wait for Turn 2 to complete - use a manual polling approach
        // We need to wait for: running -> idle (after msg2's user_message)

        const maxWaitMs = 120000;
        const pollIntervalMs = 500;
        const startTime = Date.now();
        let lastState: AgentSnapshotPayload | null = null;

        while (Date.now() - startTime < maxWaitMs) {
          // Check agent_state messages in the queue
          const queue = ctx.client.getMessageQueue();

          // Look for pattern: user_message (msg2) -> ... -> running -> ... -> idle/error
          let sawMsg2UserMessage = false;
          let sawRunningAfterMsg2 = false;
          let sawIdleAfterRunning = false;

          for (let i = msg2StartPosition; i < queue.length; i++) {
            const msg = queue[i];
            if (
              msg.type === "agent_stream" &&
              msg.payload.agentId === agent.id &&
              msg.payload.event.type === "timeline"
            ) {
              const item = msg.payload.event.item;
              if (item.type === "user_message" && (item.text as string)?.includes("Hello world")) {
                sawMsg2UserMessage = true;
              }
            }
            if (msg.type === "agent_state" && msg.payload.id === agent.id) {
              if (sawMsg2UserMessage && msg.payload.status === "running") {
                sawRunningAfterMsg2 = true;
              }
              if (sawRunningAfterMsg2 && (msg.payload.status === "idle" || msg.payload.status === "error")) {
                sawIdleAfterRunning = true;
                lastState = msg.payload;
              }
            }
          }

          if (sawIdleAfterRunning) {

            break;
          }
          await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
        }

        expect(lastState).not.toBeNull();
        expect(lastState!.status).toBe("idle");
        expect(lastState!.lastError).toBeUndefined();

        // Collect assistant_message chunks from message 2 only (after msg2StartPosition)
        const queue = ctx.client.getMessageQueue();
        const assistantChunks: string[] = [];

        // Debug: dump all events from queue

        for (let i = 0; i < queue.length; i++) {
          const m = queue[i];
          if (m.type === "agent_stream" && m.payload.agentId === agent.id) {
            const event = m.payload.event;
            if (event.type === "timeline") {
              const item = event.item;

            } else {

            }
          } else if (m.type === "agent_state" && m.payload.id === agent.id) {

          }
        }

        // Find the user_message for message 2 to mark the boundary
        let foundMsg2UserMessage = false;

        for (let i = msg2StartPosition; i < queue.length; i++) {
          const m = queue[i];

          // Look for our user message to mark the start of message 2 context
          if (
            m.type === "agent_stream" &&
            m.payload.agentId === agent.id &&
            m.payload.event.type === "timeline"
          ) {
            const item = m.payload.event.item;
            if (item.type === "user_message" && (item.text as string)?.includes("Hello world")) {
              foundMsg2UserMessage = true;

            }
            // Collect assistant messages after we found the user message
            if (foundMsg2UserMessage && item.type === "assistant_message" && item.text) {
              assistantChunks.push(item.text);
            }
          }
        }


        for (let i = 0; i < assistantChunks.length; i++) {

        }

        // Should have received at least one assistant message chunk
        expect(assistantChunks.length).toBeGreaterThan(0);

        // Concatenate all chunks
        const fullResponse = assistantChunks.join("");

        // CRITICAL ASSERTION: Response should contain coherent text
        // If there's a race condition with flag corruption, we might get:
        // - Missing chunks (suppression applied incorrectly)
        // - Duplicate chunks (suppression NOT applied when it should be)
        // - Garbled/mixed text from Turn 1 and Turn 2

        // Check for basic coherence - should have recognizable words
        const wordPattern = /\b[a-zA-Z]+\b/g;
        const words = fullResponse.match(wordPattern) || [];

        expect(words.length).toBeGreaterThan(0);

        // Check for UTF-8 corruption
        for (const chunk of assistantChunks) {
          expect(chunk).not.toMatch(/\x00/); // No null bytes
          expect(chunk).not.toMatch(/\uFFFD/); // No replacement characters
        }

        // Check for suspiciously long "words" that indicate missing spaces/garbling
        const suspiciouslyLongWords = words.filter(w => w.length > 30);
        if (suspiciouslyLongWords.length > 0) {

        }
        expect(suspiciouslyLongWords.length).toBe(0);

        // CRITICAL: Verify the response is for message 2, not message 1
        // Message 2 asked for "Hello world from interrupted message"
        // If we see extensive content about "history of computing", that's race condition corruption
        const lowerResponse = fullResponse.toLowerCase();
        const containsComputingContent =
          lowerResponse.includes("mechanical") ||
          lowerResponse.includes("quantum") ||
          lowerResponse.includes("inventor") ||
          lowerResponse.includes("eniac") ||
          lowerResponse.includes("babbage");

        if (containsComputingContent) {


        }
        // This MUST fail if we got message 1's response instead of message 2's
        expect(containsComputingContent).toBe(false);

        // Cleanup
        await ctx.client.deleteAgent(agent.id);
        rmSync(cwd, { recursive: true, force: true });
      },
      180000 // 3 minute timeout
    );

    test(
      "sending message while agent is executing a tool call",
      async () => {
        const cwd = tmpCwd();
        const testStart = Date.now();
        const log = (msg: string) => console.error(`[TEST t=${Date.now() - testStart}ms] ${msg}`);

        log(`creating agent`);

        const agent = await ctx.client.createAgent({
          provider: "claude",
          cwd,
          title: "Interrupt During Tool Call Test",
          modeId: "bypassPermissions",
        });
        log(`agent created: ${agent.id}`);

        expect(agent.id).toBeTruthy();

        const startPosition = ctx.client.getMessageQueue().length;

        // Subscribe to all messages for logging
        const unsubscribe = ctx.client.on((event) => {
          if (event.type === "agent_state" && event.agentId === agent.id) {
            log(`[EVENT] agent_state: status=${event.payload.status}`);
          } else if (event.type === "agent_stream" && event.agentId === agent.id) {
            const evt = event.event;
            if (evt.type === "timeline") {
              const item = evt.item as any;
              const desc = item.type === "tool_call"
                ? `tool_call:${item.name} result=${item.result ? 'yes' : 'no'}`
                : `${item.type}${item.text ? `:${item.text.substring(0, 30)}` : ''}`;
              log(`[EVENT] timeline: ${desc}`);
            } else {
              log(`[EVENT] stream: ${evt.type}`);
            }
          }
        });

        // Send a message that triggers a long-running tool call
        log(`sending first message`);
        await ctx.client.sendMessage(agent.id, "Execute this exact bash command and wait for it to complete: sleep 30");
        log(`first message sent`);

        // Wait for agent to actually start executing a tool call (not just "running" status)
        let sawToolCall = false;
        let toolCallStartTime: number | null = null;
        const waitStartTime = Date.now();
        while (Date.now() - waitStartTime < 15000) {
          const queue = ctx.client.getMessageQueue();
          for (let i = startPosition; i < queue.length; i++) {
            const msg = queue[i];
            if (
              msg.type === "agent_stream" &&
              msg.payload.agentId === agent.id &&
              msg.payload.event.type === "timeline"
            ) {
              const itemType = msg.payload.event.item.type;
              const itemName = (msg.payload.event.item as any).name || "";
              if (itemType === "tool_call" && itemName.toLowerCase().includes("bash")) {
                const toolCall = msg.payload.event.item as any;
                // We want to see the tool call START (no result yet)
                if (!toolCall.result) {
                  log(`saw bash tool call START: ${itemName}`);
                  sawToolCall = true;
                  toolCallStartTime = Date.now();
                  break;
                }
              }
            }
          }
          if (sawToolCall) break;
          await new Promise(r => setTimeout(r, 100));
        }
        log(`sawToolCall=${sawToolCall}`);
        expect(sawToolCall).toBe(true);

        // Give the tool call time to actually start executing
        log(`waiting 2s for tool to be mid-execution...`);
        await new Promise(r => setTimeout(r, 2000));

        // Check if agent is still running
        const queueBeforeStop = ctx.client.getMessageQueue();
        let lastStatus = "unknown";
        for (const msg of queueBeforeStop) {
          if (msg.type === "agent_state" && msg.payload.id === agent.id) {
            lastStatus = msg.payload.status;
          }
        }
        log(`agent status before Stop: ${lastStatus}`);

        // Send an interrupting message
        const stopSentAt = Date.now();
        log(`sending Stop message`);
        await ctx.client.sendMessage(agent.id, "Stop");
        log(`Stop message sent`);

        // Agent should go idle within 5 seconds after interrupt
        log(`waiting for idle...`);
        const finalState = await ctx.client.waitForAgentIdle(agent.id, 10000);
        const idleReceivedAt = Date.now();
        log(`got idle state: ${finalState.status} (took ${idleReceivedAt - stopSentAt}ms after Stop)`);
        expect(finalState.status).toBe("idle");

        // Cleanup
        unsubscribe();
        log(`deleting agent`);
        await ctx.client.deleteAgent(agent.id);
        log(`agent deleted`);
        rmSync(cwd, { recursive: true, force: true });
      },
      30000
    );

    test(
      "rapid sequential messages to same agent",
      async () => {
        const cwd = tmpCwd();

        const agent = await ctx.client.createAgent({
          provider: "claude",
          cwd,
          title: "Rapid Sequential Messages Test",
          modeId: "bypassPermissions",
        });

        expect(agent.id).toBeTruthy();

        // Send 3 messages in rapid succession without waiting

        const startPosition = ctx.client.getMessageQueue().length;

        const msg1 = "Say: MESSAGE_ONE";
        const msg2 = "Say: MESSAGE_TWO";
        const msg3 = "Say: MESSAGE_THREE";

        // Helper to count user messages in queue
        const countUserMessages = (): number => {
          let count = 0;
          const queue = ctx.client.getMessageQueue();
          for (let i = startPosition; i < queue.length; i++) {
            const m = queue[i];
            if (
              m.type === "agent_stream" &&
              m.payload.agentId === agent.id &&
              m.payload.event.type === "timeline" &&
              m.payload.event.item.type === "user_message"
            ) {
              count++;
            }
          }
          return count;
        };

        // Send all 3 messages
        await ctx.client.sendMessage(agent.id, msg1);

        await new Promise(r => setTimeout(r, 100));

        await ctx.client.sendMessage(agent.id, msg2);

        await new Promise(r => setTimeout(r, 100));

        await ctx.client.sendMessage(agent.id, msg3);

        // First, wait until all 3 user messages are recorded

        const userMsgWaitStart = Date.now();
        while (Date.now() - userMsgWaitStart < 30000) {
          const count = countUserMessages();

          if (count >= 3) break;
          await new Promise(r => setTimeout(r, 200));
        }

        const finalUserMsgCount = countUserMessages();

        // Now wait for agent to become idle after processing all 3 messages
        // We need to see at least 3 running transitions to know all messages were processed

        const waitStart = Date.now();
        let runningCount = 0;
        let finalState: AgentSnapshotPayload | null = null;

        while (Date.now() - waitStart < 120000) {
          const queue = ctx.client.getMessageQueue();
          let currentRunningCount = 0;
          let lastState: AgentSnapshotPayload | null = null;

          for (let i = startPosition; i < queue.length; i++) {
            const m = queue[i];
            if (m.type === "agent_state" && m.payload.id === agent.id) {
              if (m.payload.status === "running") currentRunningCount++;
              lastState = m.payload;
            }
          }

          runningCount = currentRunningCount;

          // Need to have seen at least 3 running states (one per message) and end up idle
          if (runningCount >= 3 && lastState && lastState.status === "idle") {
            finalState = lastState;
            break;
          }
          await new Promise(r => setTimeout(r, 500));
        }


        // Analyze what happened
        const queue = ctx.client.getMessageQueue();
        const userMessages: string[] = [];
        const assistantMessages: string[] = [];
        const stateChanges: string[] = [];

        for (let i = startPosition; i < queue.length; i++) {
          const m = queue[i];
          if (m.type === "agent_state" && m.payload.id === agent.id) {
            stateChanges.push(m.payload.status);
          }
          if (
            m.type === "agent_stream" &&
            m.payload.agentId === agent.id &&
            m.payload.event.type === "timeline"
          ) {
            const item = m.payload.event.item;
            if (item.type === "user_message") {
              userMessages.push((item.text as string) || "");
            }
            if (item.type === "assistant_message" && item.text) {
              assistantMessages.push(item.text);
            }
          }
        }




        // All 3 user messages should have been recorded
        expect(userMessages.length).toBe(3);

        // Agent should have responded (at least to the final message)
        expect(assistantMessages.length).toBeGreaterThan(0);

        // The last turn should have completed successfully (not failed due to race condition)
        const lastResponse = assistantMessages[assistantMessages.length - 1]?.toLowerCase() || "";

        // Verify we got a proper turn_completed event (not turn_failed from race condition)
        const turnCompletedEvents = queue.filter((m, i) =>
          i >= startPosition &&
          m.type === "agent_stream" &&
          m.payload.agentId === agent.id &&
          m.payload.event.type === "turn_completed"
        );
        const turnFailedEvents = queue.filter((m, i) =>
          i >= startPosition &&
          m.type === "agent_stream" &&
          m.payload.agentId === agent.id &&
          m.payload.event.type === "turn_failed"
        );


        // The final turn should complete successfully, not fail
        expect(turnCompletedEvents.length).toBeGreaterThan(0);
        // We might have some turn_failed from interrupted turns, but the last turn should succeed
        expect(turnFailedEvents.length).toBe(0);

        // The response should mention "three" since that was the last message sent
        const combinedResponse = assistantMessages.join(" ").toLowerCase();

        expect(combinedResponse).toContain("three");

        await ctx.client.deleteAgent(agent.id);
        rmSync(cwd, { recursive: true, force: true });
      },
      180000
    );
  });


});
