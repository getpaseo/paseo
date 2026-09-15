import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";
import { CodexAppServerClient } from "./codex/app-server-transport.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { CodexAppServerAgentClient, CodexAppServerAgentSession } from "./codex-app-server-agent.js";
import type { AgentSession } from "../agent-sdk-types.js";

async function readNativeThreadPath(threadId: string): Promise<string> {
  const client = new CodexAppServerClient(
    spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "pipe"] }),
    createTestLogger(),
  );
  try {
    await client.request("initialize", {
      clientInfo: { name: "paseo-archive-regression", version: "1.0.0" },
    });
    client.notify("initialized", {});
    const response = await client.request("thread/read", { threadId });
    return z.object({ thread: z.object({ path: z.string() }) }).parse(response).thread.path;
  } finally {
    await client.dispose();
  }
}

// Real native processes and a real completion. The second case represents records
// archived by older Paseo versions whose best-effort native archive failed.
test.runIf(process.env.PASEO_NATIVE_ARCHIVE_QA === "1").each([true, false])(
  "Codex history releases its process and leaves native archive unchanged (native archived: %s)",
  async (nativeArchived) => {
    const cwd = await mkdtemp(path.join(tmpdir(), "codex-history-lifecycle-"));
    const logger = createTestLogger();
    const provider = new CodexAppServerAgentClient(logger);
    const spawned: ChildProcessWithoutNullStreams[] = [];
    let active: AgentSession | undefined;
    let history: CodexAppServerAgentSession | undefined;
    try {
      const catalog = await provider.fetchCatalog({ scope: "global", force: false });
      const model = catalog.models.find((entry) => entry.isDefault)!;
      const config = {
        provider: "codex",
        cwd,
        model: model.id,
        modeId: "full-access",
        thinkingOptionId: "low",
      };
      const initialProcesses: ChildProcessWithoutNullStreams[] = [];
      const initial = new CodexAppServerAgentSession(config, null, logger, async () => {
        const child = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });
        initialProcesses.push(child);
        return child;
      });
      active = initial;
      await initial.connect();
      const reply = await active.run(
        "Reply with exactly HISTORY_REMAINS_READ_ONLY. Do not use tools.",
      );
      expect(reply.finalText).toContain("HISTORY_REMAINS_READ_ONLY");
      const handle = active.describePersistence()!;
      await active.close();
      active = undefined;
      expect(
        initialProcesses.every((child) => child.exitCode !== null || child.signalCode !== null),
      ).toBe(true);
      if (nativeArchived) await provider.archiveNativeSession(handle);

      const nativePath = await readNativeThreadPath(handle.sessionId);
      expect(nativePath.includes(`${path.sep}archived_sessions${path.sep}`)).toBe(nativeArchived);
      history = new CodexAppServerAgentSession(
        config,
        handle,
        logger,
        async () => {
          const child = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });
          spawned.push(child);
          return child;
        },
        {},
        false,
        false,
        false,
        undefined,
        "history",
      );
      await history.connect();
      const text: string[] = [];
      for await (const event of history.streamHistory()) {
        if (event.type === "timeline" && event.item.type === "assistant_message")
          text.push(event.item.text);
      }
      expect(text.join("\n")).toContain("HISTORY_REMAINS_READ_ONLY");
      expect(spawned).toHaveLength(1);
      expect(
        spawned.filter((child) => child.exitCode === null && child.signalCode === null),
      ).toEqual([]);

      expect(await readNativeThreadPath(handle.sessionId)).toBe(nativePath);

      // Native unarchive is possible after reading history; history held no writer.
      await provider.unarchiveNativeSession(handle);
      active = await provider.resumeSession(handle, config);
      expect(active.describePersistence()?.sessionId).toBe(handle.sessionId);
      const followUp = await active.run(
        "Repeat exactly your previous assistant reply from this conversation. Do not use tools.",
      );
      expect(followUp.finalText).toContain("HISTORY_REMAINS_READ_ONLY");
      expect(active.describePersistence()?.sessionId).toBe(handle.sessionId);
    } finally {
      await history?.close();
      await active?.close();
      await rm(cwd, { recursive: true, force: true });
    }
  },
  120_000,
);

test.runIf(process.env.PASEO_NATIVE_ARCHIVE_QA === "1")(
  "a failed Codex history read releases its temporary process",
  async () => {
    const spawned: ChildProcessWithoutNullStreams[] = [];
    const session = new CodexAppServerAgentSession(
      { provider: "codex", cwd: tmpdir() },
      { sessionId: "00000000-0000-4000-8000-000000000001" },
      createTestLogger(),
      async () => {
        const child = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });
        spawned.push(child);
        return child;
      },
      {},
      false,
      false,
      false,
      undefined,
      "history",
    );
    try {
      await expect(session.connect()).rejects.toThrow();
      expect(spawned).toHaveLength(1);
      expect(spawned.every((child) => child.exitCode !== null || child.signalCode !== null)).toBe(
        true,
      );
    } finally {
      await session.close();
    }
  },
  30_000,
);
