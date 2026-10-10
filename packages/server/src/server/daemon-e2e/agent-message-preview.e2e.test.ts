import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

import { createDaemonTestContext } from "../test-utils/index.js";

interface StoredPreviewMessage {
  role: "user" | "assistant";
  text: string;
}

/** The record path includes a project directory, so look one level down too. */
function readStoredAgent(paseoHomeRoot: string, agentId: string): Record<string, unknown> {
  const agentsDir = path.join(paseoHomeRoot, ".paseo", "agents");
  const candidates = [path.join(agentsDir, `${agentId}.json`)];
  for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      candidates.push(path.join(agentsDir, entry.name, `${agentId}.json`));
    }
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(readFileSync(candidate, "utf8")) as Record<string, unknown>;
    } catch {
      // Keep looking: the record can live in a project directory.
    }
  }
  throw new Error(`stored agent ${agentId} not found under ${agentsDir}`);
}

/**
 * The record is rewritten from queued snapshot flushes, so a just-finished turn
 * can land a moment after it reports done.
 */
async function waitForStoredPreview(
  paseoHomeRoot: string,
  agentId: string,
  settled: (messages: StoredPreviewMessage[]) => boolean,
  timeoutMs = 5000,
): Promise<StoredPreviewMessage[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const preview =
      (readStoredAgent(paseoHomeRoot, agentId) as { previewMessages?: StoredPreviewMessage[] })
        .previewMessages ?? [];
    if (settled(preview) || Date.now() >= deadline) {
      return preview;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function writeStoredAgent(
  agentsDir: string,
  agentId: string,
  input: { title: string; updatedAt: string; previewMessages?: StoredPreviewMessage[] },
): void {
  writeFileSync(
    path.join(agentsDir, `${agentId}.json`),
    `${JSON.stringify(
      {
        id: agentId,
        provider: "codex",
        cwd: "/tmp",
        createdAt: input.updatedAt,
        updatedAt: input.updatedAt,
        lastActivityAt: input.updatedAt,
        lastUserMessageAt: input.updatedAt,
        title: input.title,
        labels: {},
        lastStatus: "idle",
        config: null,
        persistence: null,
        ...(input.previewMessages ? { previewMessages: input.previewMessages } : {}),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

test("a finished turn stores the newest messages for history search", async () => {
  const paseoHomeRoot = mkdtempSync(path.join(os.tmpdir(), "paseo-preview-home-"));
  const ctx = await createDaemonTestContext({ paseoHomeRoot });
  try {
    const agent = await ctx.client.createAgent({
      provider: "codex",
      cwd: "/tmp",
      title: "Preview probe",
    });
    await ctx.client.sendMessage(
      agent.id,
      "remember the word pineapple. respond with exactly: THE_REPLY_MARKER",
    );
    await ctx.client.waitForFinish(agent.id, 120000);

    const record = readStoredAgent(paseoHomeRoot, agent.id) as {
      previewMessages?: StoredPreviewMessage[];
    };
    expect(record.previewMessages?.[0]).toMatchObject({ role: "user" });
    expect(record.previewMessages?.[0]?.text).toContain("pineapple");

    // The record is rewritten from queued snapshot flushes, so the reply lands a
    // moment after the turn finishes.
    const preview = await waitForStoredPreview(paseoHomeRoot, agent.id, (messages) =>
      messages.some((message) => message.role === "assistant"),
    );
    expect(preview[1]).toEqual({
      role: "assistant",
      text: "THE_REPLY_MARKER",
    });

    // The word exists only in the question, never in the title.
    const byQuestion = await ctx.client.fetchAgentHistory({ search: "pineapple" });
    const questionRow = byQuestion.entries.find((entry) => entry.agent.id === agent.id);
    expect(questionRow).toBeDefined();
    expect(questionRow?.searchSnippet).toMatchObject({ role: "user" });

    // And `THE_REPLY_MARKER` only in the reply.
    const byReply = await ctx.client.fetchAgentHistory({ search: "THE_REPLY_MARKER" });
    expect(byReply.entries.find((entry) => entry.agent.id === agent.id)?.searchSnippet).toEqual({
      role: "assistant",
      text: "THE_REPLY_MARKER",
    });
  } finally {
    await ctx.cleanup();
    rmSync(paseoHomeRoot, { recursive: true, force: true });
  }
}, 180000);

test("history search stays bounded with a large stored history", async () => {
  const paseoHomeRoot = mkdtempSync(path.join(os.tmpdir(), "paseo-preview-scale-home-"));
  const agentsDir = path.join(paseoHomeRoot, ".paseo", "agents");
  mkdirSync(agentsDir, { recursive: true });
  const total = 900;
  const matching = 40;
  for (let index = 0; index < total; index += 1) {
    // The newest 40 rows match by title; 40 older rows match only inside a reply.
    const titleMatch = index < matching;
    const messageMatch = index >= 400 && index < 400 + matching;
    writeStoredAgent(agentsDir, `agent-scale-${index}`, {
      title: titleMatch ? `Needle session ${index}` : `Routine session ${index}`,
      updatedAt: new Date(Date.UTC(2026, 5, 1, 0, 0, total - index)).toISOString(),
      previewMessages: [
        { role: "user", text: `question ${index} about the release checklist` },
        {
          role: "assistant",
          text: messageMatch
            ? `the needle is in session ${index}`
            : `answer ${index} with no special word`,
        },
      ],
    });
  }

  const ctx = await createDaemonTestContext({ paseoHomeRoot });
  try {
    const started = performance.now();
    const page = await ctx.client.fetchAgentHistory({ search: "needle", page: { limit: 200 } });
    const elapsedMs = performance.now() - started;

    // 40 rows match by title and 40 older rows only inside a reply.
    expect(page.entries.length).toBe(matching * 2);
    expect(page.entries.some((entry) => entry.searchSnippet?.role === "assistant")).toBe(true);
    // Generous for CI; the point is that a search over 900 stored agents does not
    // read any of them from disk or scan a transcript.
    expect(elapsedMs).toBeLessThan(2000);

    const warmStarted = performance.now();
    await ctx.client.fetchAgentHistory({ search: "needle", page: { limit: 200 } });
    expect(performance.now() - warmStarted).toBeLessThan(2000);

    console.log(`[scale] history search over ${total} stored agents: ${elapsedMs.toFixed(0)}ms`);
  } finally {
    await ctx.cleanup();
    rmSync(paseoHomeRoot, { recursive: true, force: true });
  }
}, 180000);
