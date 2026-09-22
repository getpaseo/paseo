import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

import type { AgentSession } from "../agent-sdk-types.js";
import { CodexAppServerAgentSession } from "./codex-app-server-agent.js";
import { CodexAppServerClient } from "./codex/app-server-transport.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";

const fixturePath = fileURLToPath(
  new URL("./codex/test-utils/persisted-reviewer-app-server.ts", import.meta.url),
);
const nativeTest = test.runIf(process.env.PASEO_NATIVE_REVIEWER_QA === "1");

interface ReviewerContext {
  approvalPolicy: string;
  approvalsReviewer: string;
  sandbox: { type: string };
}

interface FixtureState extends ReviewerContext {
  threadId: string;
  modelTurnsStarted: number;
  resumeOverridesIgnored: number;
}

function expectReviewerContext(context: ReviewerContext, reviewer: "user" | "auto_review"): void {
  expect(context).toMatchObject({
    approvalPolicy: "on-request",
    approvalsReviewer: reviewer,
    sandbox: { type: "workspaceWrite" },
  });
}

function spawnNativeAppServer(cwd: string, codexHome: string): ChildProcessWithoutNullStreams {
  return spawn("codex", ["app-server", "--stdio"], {
    cwd,
    env: { ...process.env, CODEX_HOME: codexHome },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

async function startNativeClient(cwd: string, codexHome: string): Promise<CodexAppServerClient> {
  const client = new CodexAppServerClient(spawnNativeAppServer(cwd, codexHome), createTestLogger());
  await client.request("initialize", {
    clientInfo: { name: "paseo-native-reviewer-lifecycle", version: "1.0.0" },
    capabilities: { experimentalApi: true },
  });
  client.notify("initialized", {});
  return client;
}

nativeTest(
  "Default reviewer clears a persisted native auto-reviewer after app-server restart without a model turn",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-codex-reviewer-native-"));
    const cwd = path.join(root, "workspace");
    const codexHome = path.join(root, "codex-home");
    let client: CodexAppServerClient | undefined;
    let threadId: string | undefined;
    try {
      await Promise.all([mkdir(cwd, { recursive: true }), mkdir(codexHome, { recursive: true })]);
      client = await startNativeClient(cwd, codexHome);
      const started = (await client.request("thread/start", {
        cwd,
        model: "gpt-5.6-terra",
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        sandbox: "workspace-write",
      })) as { thread: { id: string } & ReviewerContext } & ReviewerContext;
      threadId = started.thread.id;
      expectReviewerContext(started, "auto_review");
      await client.request("thread/inject_items", {
        threadId,
        items: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Native reviewer lifecycle fixture." }],
          },
        ],
      });
      await client.dispose();
      client = undefined;

      client = await startNativeClient(cwd, codexHome);
      expect(await client.request("thread/loaded/list", {})).toMatchObject({ data: [] });
      const resumed = (await client.request("thread/resume", {
        threadId,
        approvalsReviewer: "user",
      })) as ReviewerContext;
      // thread/resume is Codex's live native thread-context readback; thread/read
      // intentionally returns persisted history metadata without these settings.
      expectReviewerContext(resumed, "user");
    } finally {
      if (client && threadId) await client.request("thread/archive", { threadId }).catch(() => {});
      await client?.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);

nativeTest(
  "loaded threads ignore resume overrides until Default sends user on the zero-model fixture turn",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-codex-reviewer-fixture-"));
    const statePath = path.join(root, "state.json");
    const initialState: FixtureState = {
      threadId: "fixture-thread",
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
      sandbox: { type: "workspaceWrite" },
      modelTurnsStarted: 0,
      resumeOverridesIgnored: 0,
    };
    await writeFile(statePath, `${JSON.stringify(initialState)}\n`);
    let control: CodexAppServerClient | undefined;
    let session: AgentSession | undefined;
    try {
      const spawnFixture = () =>
        spawn(process.execPath, ["--import", "tsx", fixturePath, statePath], {
          stdio: ["pipe", "pipe", "pipe"],
        });
      control = new CodexAppServerClient(spawnFixture(), createTestLogger());
      await control.request("initialize", {
        clientInfo: { name: "fixture-control", version: "1" },
      });
      control.notify("initialized", {});
      expect(await control.request("thread/loaded/list", {})).toEqual({ data: ["fixture-thread"] });
      await control.request("thread/resume", {
        threadId: "fixture-thread",
        approvalsReviewer: "user",
      });
      expectReviewerContext(
        (await control.request("thread/read", { threadId: "fixture-thread" })) as ReviewerContext,
        "auto_review",
      );
      await control.dispose();
      control = undefined;

      session = new CodexAppServerAgentSession(
        {
          provider: "codex",
          cwd: root,
          model: "gpt-5.6-terra",
          modeId: "auto",
          thinkingOptionId: "medium",
        },
        { sessionId: "fixture-thread" },
        createTestLogger(),
        async () => spawnFixture(),
      );
      await session.run("fixture turn only; do not call a provider model");

      const finalState = JSON.parse(await readFile(statePath, "utf8")) as FixtureState;
      expectReviewerContext(finalState, "user");
      expect(finalState.resumeOverridesIgnored).toBe(1);
      expect(finalState.modelTurnsStarted).toBe(1);
    } finally {
      await control?.dispose();
      await session?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
