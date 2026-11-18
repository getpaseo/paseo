import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";

import type { AgentPromptInput } from "../agent/agent-sdk-types.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";

// A persisted agent that is not loaded. Loading it resumes the provider session, which for a long
// session replays its whole history: these tests make that resume slow or fail on purpose.
const AGENT_ID = "6f1d2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b";
const PROMPT_WINDOW_MS = 1_000;

interface Gate {
  promise: Promise<void>;
  open(): void;
  fail(error: Error): void;
}

function gate(): Gate {
  let open!: () => void;
  let fail!: (error: Error) => void;
  const promise = new Promise<void>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  void promise.catch(() => undefined);
  return { promise, open, fail };
}

function promptText(prompt: AgentPromptInput): string {
  return typeof prompt === "string"
    ? prompt
    : prompt.map((block) => ("text" in block ? block.text : "")).join("");
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function startDaemon(options: {
  paseoHomeRoot: string;
  cwd: string;
  resume: Gate | null;
  turns: string[];
}): Promise<{ daemon: TestPaseoDaemon; client: DaemonClient }> {
  const daemon = await createTestPaseoDaemon({
    paseoHomeRoot: options.paseoHomeRoot,
    cleanup: false,
    agentClients: {
      claude: createTestAgentClient("claude", {
        beforeResumeSession: async () => {
          await options.resume?.promise;
        },
        onStartTurn: (prompt) => {
          options.turns.push(promptText(prompt));
        },
      }),
    },
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  await client.connect();
  return { daemon, client };
}

async function seedUnloadedAgent(daemon: TestPaseoDaemon, cwd: string): Promise<void> {
  const now = new Date().toISOString();
  await daemon.daemon.agentStorage.upsert({
    id: AGENT_ID,
    provider: "claude",
    cwd,
    createdAt: now,
    updatedAt: now,
    title: "Long session",
    labels: {},
    metadata: {},
    lastStatus: "closed",
    config: { modeId: "default", model: "claude-test-model" },
    persistence: { provider: "claude", sessionId: "long-session", metadata: { cwd } },
  } as never);
}

function fixtureDirs() {
  const root = mkdtempSync(path.join(os.tmpdir(), "paseo-unloaded-agent-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "repo");
  mkdirSync(cwd, { recursive: true });
  return { paseoHomeRoot: path.join(root, "home"), cwd };
}

async function settlesWithin<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`did not settle within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function eventually(check: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("a send to an unloaded agent answers before the slow load and is delivered after it", async () => {
  const { paseoHomeRoot, cwd } = fixtureDirs();
  const resume = gate();
  const turns: string[] = [];
  const { daemon, client } = await startDaemon({ paseoHomeRoot, cwd, resume, turns });
  cleanups.push(async () => {
    resume.open();
    await client.close().catch(() => undefined);
    await daemon.close().catch(() => undefined);
  });
  await seedUnloadedAgent(daemon, cwd);

  const receipt = await settlesWithin(
    client.sendAgentMessage(AGENT_ID, "after the restart", { messageId: "message-1" }),
    PROMPT_WINDOW_MS,
  );
  expect(receipt).toEqual({ deliveryStatus: "queued", revived: true });
  expect(turns).toEqual([]);

  // A sender that waits for the turn is not told the agent finished before it started.
  let finished = false;
  const waited = client.waitForFinish(AGENT_ID, 10_000).then((result) => {
    finished = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(finished).toBe(false);

  resume.open();
  expect((await waited).status).toBe("idle");
  await eventually(() => turns.length > 0);
  expect(turns).toHaveLength(1);
  expect(turns[0]).toContain("after the restart");

  // Retrying the same message after its delivery does not deliver it again.
  await client.sendAgentMessage(AGENT_ID, "after the restart", { messageId: "message-1" });
  expect(turns).toHaveLength(1);
});

test("a failed background load reports the undelivered message on the agent", async () => {
  const { paseoHomeRoot, cwd } = fixtureDirs();
  const resume = gate();
  const turns: string[] = [];
  const { daemon, client } = await startDaemon({ paseoHomeRoot, cwd, resume, turns });
  cleanups.push(async () => {
    await client.close().catch(() => undefined);
    await daemon.close().catch(() => undefined);
  });
  await seedUnloadedAgent(daemon, cwd);

  const receipt = await settlesWithin(
    client.sendAgentMessage(AGENT_ID, "please run the migration", { messageId: "message-3" }),
    PROMPT_WINDOW_MS,
  );
  expect(receipt.revived).toBe(true);
  resume.fail(new Error("provider session is gone"));

  await eventually(async () => {
    const record = await daemon.daemon.agentStorage.get(AGENT_ID);
    return Boolean(record?.lastError);
  });
  const record = await daemon.daemon.agentStorage.get(AGENT_ID);
  expect(record?.lastError).toContain("please run the migration");
  expect(record?.lastError).toContain("provider session is gone");
  expect(record?.requiresAttention).toBe(true);
  expect(record?.attentionReason).toBe("error");
  expect(turns).toEqual([]);
  // The failure was reported, so a later start does not deliver the message behind the user.
  expect(readdirSync(path.join(daemon.paseoHome, "agent-requests", "accepted"))).toEqual([]);
});

test("a message accepted before a restart is delivered by the next daemon", async () => {
  const { paseoHomeRoot, cwd } = fixtureDirs();
  const resume = gate();
  const firstTurns: string[] = [];
  const first = await startDaemon({ paseoHomeRoot, cwd, resume, turns: firstTurns });
  await seedUnloadedAgent(first.daemon, cwd);
  const receipt = await settlesWithin(
    first.client.sendAgentMessage(AGENT_ID, "survive the restart", { messageId: "message-4" }),
    PROMPT_WINDOW_MS,
  );
  expect(receipt.revived).toBe(true);

  // The daemon stops while the agent is still loading.
  await first.client.close();
  const stopping = first.daemon.close();
  resume.open();
  await stopping;
  expect(firstTurns).toEqual([]);

  const turns: string[] = [];
  const second = await startDaemon({ paseoHomeRoot, cwd, resume: null, turns });
  cleanups.push(async () => {
    await second.client.close().catch(() => undefined);
    await second.daemon.close().catch(() => undefined);
  });
  await eventually(() => turns.length > 0);
  expect(turns).toHaveLength(1);
  expect(turns[0]).toContain("survive the restart");
});
