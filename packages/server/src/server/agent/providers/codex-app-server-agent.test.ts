import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CodexAppServerAgentClient,
  codexAppServerTurnInputFromPrompt,
} from "./codex-app-server-agent.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import type {
  AgentPermissionRequest,
  AgentPromptContentBlock,
  AgentTimelineItem,
} from "../agent-sdk-types.js";

const CODEX_TEST_MODEL = "gpt-5.1-codex-mini";
const CODEX_TEST_REASONING_EFFORT = "low";
const ONE_BY_ONE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X1r0AAAAASUVORK5CYII=";

function isCodexInstalled(): boolean {
  try {
    const out = execFileSync("which", ["codex"], { encoding: "utf8" }).trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

function tmpCwd(prefix = "codex-app-server-e2e-"): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function useTempCodexSessionDir(): () => void {
  const codexSessionDir = tmpCwd("codex-sessions-");
  const prevSessionDir = process.env.CODEX_SESSION_DIR;
  process.env.CODEX_SESSION_DIR = codexSessionDir;
  return () => {
    if (prevSessionDir === undefined) {
      delete process.env.CODEX_SESSION_DIR;
    } else {
      process.env.CODEX_SESSION_DIR = prevSessionDir;
    }
    rmSync(codexSessionDir, { recursive: true, force: true });
  };
}

function hasShellCommand(item: AgentTimelineItem, commandFragment: string): boolean {
  if (item.type !== "tool_call" || item.name !== "shell") return false;
  const input = item.input as { command?: string } | undefined;
  const command = input?.command ?? "";
  return command.includes(commandFragment);
}

function hasApplyPatchFile(item: AgentTimelineItem, fileName: string): boolean {
  if (item.type !== "tool_call" || item.name !== "apply_patch") return false;
  const input = item.input as { files?: Array<{ path?: string }> } | undefined;
  const output = item.output as
    | { files?: Array<{ path?: string; patch?: string }>; diff?: string }
    | undefined;
  const inInput = (input?.files ?? []).some((file) => file?.path === fileName);
  const inOutput = (output?.files ?? []).some((file) => file?.path === fileName);
  const inDiff = typeof output?.diff === "string" && output.diff.includes(fileName);
  return inInput || inOutput || inDiff;
}

describe("Codex app-server provider (integration)", () => {
  const logger = createTestLogger();

  test("maps image prompt blocks to Codex localImage input", async () => {
    const input = await codexAppServerTurnInputFromPrompt(
      [
        { type: "text", text: "hello" },
        { type: "image", mimeType: "image/png", data: ONE_BY_ONE_PNG_BASE64 },
      ],
      logger
    );
    const localImage = input.find((item) => (item as any)?.type === "localImage") as
      | { type: "localImage"; path?: string }
      | undefined;
    expect(localImage?.path).toBeTypeOf("string");
    if (localImage?.path) {
      expect(existsSync(localImage.path)).toBe(true);
      rmSync(localImage.path, { force: true });
    }
  });

  test.runIf(isCodexInstalled())("listModels returns live Codex models", async () => {
    const client = new CodexAppServerAgentClient(logger);
    const models = await client.listModels();
    expect(models.some((model) => model.id.includes("gpt-5.1-codex"))).toBe(true);
  }, 30000);

  test.runIf(isCodexInstalled())("accepts image prompt blocks without request validation errors", async () => {
    const cleanup = useTempCodexSessionDir();
    const cwd = tmpCwd("codex-image-prompt-");

    try {
      const client = new CodexAppServerAgentClient(logger);
      const session = await client.createSession({
        provider: "codex",
        cwd,
        modeId: "auto",
        model: CODEX_TEST_MODEL,
        reasoningEffort: CODEX_TEST_REASONING_EFFORT,
      });

      const result = await session.run([
        { type: "text", text: "Reply with exactly: OK." },
        { type: "image", mimeType: "image/png", data: ONE_BY_ONE_PNG_BASE64 },
      ] satisfies AgentPromptContentBlock[]);
      await session.close();

      expect(result.finalText).toContain("OK");
    } finally {
      cleanup();
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 60000);

  test.runIf(isCodexInstalled())("getRuntimeInfo reflects model + mode", async () => {
    const cleanup = useTempCodexSessionDir();
    const cwd = tmpCwd("codex-runtime-");

    try {
      const client = new CodexAppServerAgentClient(logger);
      const session = await client.createSession({
        provider: "codex",
        cwd,
        modeId: "auto",
        model: CODEX_TEST_MODEL,
        reasoningEffort: CODEX_TEST_REASONING_EFFORT,
      });

      await session.run("Reply with OK.");
      const info = await session.getRuntimeInfo();
      await session.close();

      expect(info.model).toBe(CODEX_TEST_MODEL);
      expect(info.modeId).toBe("auto");
      expect(info.sessionId?.length).toBeGreaterThan(0);
    } finally {
      cleanup();
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 30000);

  test.runIf(isCodexInstalled())("listCommands includes custom prompts and executeCommand runs them", async () => {
    const cleanup = useTempCodexSessionDir();
    const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
    const promptsDir = path.join(codexHome, "prompts");
    const promptPath = path.join(promptsDir, "test.md");
    const cwd = tmpCwd("codex-cmd-");

    mkdirSync(promptsDir, { recursive: true });
    writeFileSync(
      promptPath,
      "---\ndescription: Test Prompt\n---\nReply with exactly: OK-$ARGUMENTS.",
      "utf8"
    );

    try {
      const client = new CodexAppServerAgentClient(logger);
      const session = await client.createSession({
        provider: "codex",
        cwd,
        modeId: "auto",
        model: CODEX_TEST_MODEL,
        reasoningEffort: CODEX_TEST_REASONING_EFFORT,
      });

      const commands = await session.listCommands?.();
      expect(commands?.some((cmd) => cmd.name === "prompts:test")).toBe(true);

      const result = await session.executeCommand?.("prompts:test", "world");
      await session.close();

      expect(result?.text.trim()).toContain("OK-world");
    } finally {
      cleanup();
      rmSync(cwd, { recursive: true, force: true });
      rmSync(promptPath, { force: true });
    }
  }, 60000);

  test.runIf(isCodexInstalled())("command approval flow requests permission and runs command", async () => {
    const cleanup = useTempCodexSessionDir();
    const cwd = tmpCwd("codex-cmd-approval-");
    const filePath = path.join(cwd, "permission.txt");

    try {
      const client = new CodexAppServerAgentClient(logger);
      const session = await client.createSession({
        provider: "codex",
        cwd,
        modeId: "auto",
        approvalPolicy: "on-request",
        model: CODEX_TEST_MODEL,
        reasoningEffort: CODEX_TEST_REASONING_EFFORT,
      });

      let sawPermission = false;
      let captured: AgentPermissionRequest | null = null;
      let sawPermissionResolved = false;
      const timelineItems: AgentTimelineItem[] = [];

      const events = session.stream(
        [
          "You must use your shell tool to run the exact command",
          "`printf \"ok\" > permission.txt`.",
          "If you need approval before running it, request approval first.",
          "After approval, run it and reply DONE.",
        ].join(" ")
      );

      let failure: string | null = null;
      for await (const event of events) {
        if (event.type === "permission_requested" && event.request.name === "CodexBash") {
          sawPermission = true;
          captured = event.request;
          await session.respondToPermission(event.request.id, { behavior: "allow" });
        }
        if (
          event.type === "permission_resolved" &&
          captured &&
          event.requestId === captured.id &&
          event.resolution.behavior === "allow"
        ) {
          sawPermissionResolved = true;
        }
        if (event.type === "timeline" && event.item.type === "tool_call") {
          timelineItems.push(event.item);
        }
        if (event.type === "turn_failed") {
          failure = event.error;
          break;
        }
        if (event.type === "turn_completed") {
          break;
        }
      }

      await session.close();

      if (failure) {
        throw new Error(failure);
      }
      if (captured) {
        expect(sawPermissionResolved).toBe(true);
      }
      expect(sawPermission || timelineItems.length > 0).toBe(true);
      expect(
        timelineItems.some((item) => item.type === "tool_call" && item.name === "shell")
      ).toBe(true);
      expect(existsSync(filePath)).toBe(true);
      expect(readFileSync(filePath, "utf8")).toContain("ok");
    } finally {
      cleanup();
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 60000);

  test.runIf(isCodexInstalled())(
    "streams responses and maps shell + file change tool calls into timeline items",
    async () => {
      const cleanup = useTempCodexSessionDir();
      const cwd = tmpCwd("codex-stream-");
      const shellFile = path.join(cwd, "shell.txt");
      const patchFile = path.join(cwd, "patch.txt");

      try {
        const client = new CodexAppServerAgentClient(logger);
        const session = await client.createSession({
          provider: "codex",
          cwd,
          modeId: "full-access",
          approvalPolicy: "on-request",
          model: CODEX_TEST_MODEL,
          reasoningEffort: CODEX_TEST_REASONING_EFFORT,
        });

        let sawAssistantMessage = false;
        let sawShellTool = false;
        let sawPatchTool = false;
        let sawShellCompleted = false;
        let sawPatchCompleted = false;
        const timelineItems: AgentTimelineItem[] = [];

        const shellEvents = session.stream(
          "Run the exact shell command `printf \"ok\" > shell.txt`. After it completes, reply SHELL_DONE."
        );
        let failure: string | null = null;
        for await (const event of shellEvents) {
          if (event.type === "permission_requested") {
            await session.respondToPermission(event.request.id, { behavior: "allow" });
          }
          if (event.type === "timeline") {
            timelineItems.push(event.item);
            if (event.item.type === "assistant_message") {
              sawAssistantMessage = true;
            }
            if (hasShellCommand(event.item, "printf")) {
              sawShellTool = true;
              if (event.item.status === "completed") {
                sawShellCompleted = true;
              }
            }
          }
          if (event.type === "turn_failed") {
            failure = event.error;
            break;
          }
          if (event.type === "turn_completed") {
            break;
          }
        }

        if (failure) {
          throw new Error(failure);
        }

        const patch = [
          "*** Begin Patch",
          "*** Add File: patch.txt",
          "+patched",
          "*** End Patch",
        ].join("\\n");
        const patchEvents = session.stream(
          [
            "Use the apply_patch tool and nothing else.",
            "Do not use the shell tool for file changes.",
            "Do not respond with any message until the apply_patch tool completes.",
            "Apply the following patch exactly:",
            patch,
            "After it completes, reply PATCH_DONE.",
          ].join("\\n")
        );

        for await (const event of patchEvents) {
          if (event.type === "permission_requested") {
            await session.respondToPermission(event.request.id, { behavior: "allow" });
          }
          if (event.type === "timeline") {
            timelineItems.push(event.item);
            if (event.item.type === "assistant_message") {
              sawAssistantMessage = true;
            }
            if (hasApplyPatchFile(event.item, "patch.txt")) {
              sawPatchTool = true;
              if (event.item.status === "completed") {
                sawPatchCompleted = true;
              }
            }
          }
          if (event.type === "turn_failed") {
            failure = event.error;
            break;
          }
          if (event.type === "turn_completed") {
            break;
          }
        }

        await session.close();

        if (failure) {
          throw new Error(failure);
        }

        expect(sawAssistantMessage).toBe(true);
        expect(sawShellTool).toBe(true);
        expect(sawPatchTool).toBe(true);
        expect(sawShellCompleted || existsSync(shellFile)).toBe(true);
        expect(sawPatchCompleted || existsSync(patchFile)).toBe(true);
        expect(readFileSync(shellFile, "utf8")).toContain("ok");
        expect(readFileSync(patchFile, "utf8").trim()).toBe("patched");

        const shellItem = timelineItems.find((item) => hasShellCommand(item, "printf"));
        const patchItem = timelineItems.find((item) => hasApplyPatchFile(item, "patch.txt"));
        expect(shellItem?.type).toBe("tool_call");
        expect(patchItem?.type).toBe("tool_call");
        if (shellItem?.type === "tool_call") {
          expect(shellItem.name).toBe("shell");
          expect(shellItem.input).toBeTruthy();
        }
        if (patchItem?.type === "tool_call") {
          expect(patchItem.name).toBe("apply_patch");
          expect(patchItem.input || patchItem.output).toBeTruthy();
        }
      } finally {
        cleanup();
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    120000
  );

  test.runIf(isCodexInstalled())(
    "interrupts long-running commands and emits a canceled turn",
    async () => {
      const cleanup = useTempCodexSessionDir();
      const cwd = tmpCwd("codex-interrupt-");

      let session: Awaited<ReturnType<CodexAppServerAgentClient["createSession"]>> | null = null;
      let followupSession: Awaited<ReturnType<CodexAppServerAgentClient["createSession"]>> | null =
        null;
      let interruptAt: number | null = null;
      let stoppedAt: number | null = null;

      try {
        const client = new CodexAppServerAgentClient(logger);
        session = await client.createSession({
          provider: "codex",
          cwd,
          modeId: "auto",
          approvalPolicy: "on-request",
          model: CODEX_TEST_MODEL,
          reasoningEffort: CODEX_TEST_REASONING_EFFORT,
        });

        const stream = session.stream(
          "Run the exact shell command `sleep 60` using your shell tool and do not respond until it finishes."
        );

        let sawSleepCommand = false;
        for await (const event of stream) {
          if (event.type === "permission_requested") {
            await session.respondToPermission(event.request.id, { behavior: "allow" });
          }
          if (
            event.type === "timeline" &&
            event.item.type === "tool_call" &&
            event.item.name === "shell" &&
            hasShellCommand(event.item, "sleep 60")
          ) {
            sawSleepCommand = true;
            if (!interruptAt) {
              interruptAt = Date.now();
              await session.interrupt();
            }
          }
          if (event.type === "turn_canceled") {
            stoppedAt = Date.now();
            break;
          }
          if (event.type === "turn_completed" || event.type === "turn_failed") {
            stoppedAt = Date.now();
            break;
          }
        }

        if (!interruptAt) {
          throw new Error("Did not issue interrupt for long-running command");
        }
        if (!stoppedAt) {
          stoppedAt = Date.now();
        }
        const latencyMs = stoppedAt - interruptAt;
        expect(sawSleepCommand).toBe(true);
        expect(latencyMs).toBeGreaterThanOrEqual(0);
        expect(latencyMs).toBeLessThan(10_000);

        await session.close();
        session = null;

        followupSession = await client.createSession({
          provider: "codex",
          cwd,
          modeId: "auto",
          model: CODEX_TEST_MODEL,
          reasoningEffort: CODEX_TEST_REASONING_EFFORT,
        });
        const followup = await followupSession.run("Reply OK and stop.");
        expect(followup.finalText.toLowerCase()).toContain("ok");
      } finally {
        await session?.close();
        await followupSession?.close();
        cleanup();
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    120000
  );

  test.runIf(isCodexInstalled())(
    "persists session metadata and resumes with history",
    async () => {
      const cleanup = useTempCodexSessionDir();
      const cwd = tmpCwd("codex-resume-");
      const token = `ALPHA-${Date.now()}`;

      let session: Awaited<ReturnType<CodexAppServerAgentClient["createSession"]>> | null = null;
      let resumed: Awaited<ReturnType<CodexAppServerAgentClient["resumeSession"]>> | null = null;

      try {
        const client = new CodexAppServerAgentClient(logger);
        session = await client.createSession({
          provider: "codex",
          cwd,
          modeId: "auto",
          model: CODEX_TEST_MODEL,
          reasoningEffort: CODEX_TEST_REASONING_EFFORT,
        });

        const first = await session.run(`Remember the word ${token} and reply ACK.`);
        expect(first.finalText.toLowerCase()).toContain("ack");

        const handle = session.describePersistence();
        expect(handle?.sessionId).toBeTruthy();
        expect(handle?.metadata?.threadId).toBe(handle?.sessionId);

        await session.close();
        session = null;

        resumed = await client.resumeSession(handle!);
        const history: AgentTimelineItem[] = [];
        for await (const event of resumed.streamHistory()) {
          if (event.type === "timeline") {
            history.push(event.item);
          }
        }

        expect(
          history.some(
            (item) => item.type === "assistant_message" || item.type === "user_message"
          )
        ).toBe(true);

        const response = await resumed.run(
          `Respond with the exact token ${token} and stop.`
        );
        expect(response.finalText).toContain(token);

        const resumedHandle = resumed.describePersistence();
        expect(resumedHandle?.sessionId).toBe(handle?.sessionId);
        expect(resumedHandle?.metadata?.threadId).toBe(handle?.sessionId);
      } finally {
        await session?.close();
        await resumed?.close();
        cleanup();
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    180000
  );

  test.runIf(isCodexInstalled())(
    "emits plan items and resolves collaboration mode mapping",
    async () => {
      const cleanup = useTempCodexSessionDir();
      const cwd = tmpCwd("codex-plan-");

      try {
        const client = new CodexAppServerAgentClient(logger);
        const session = await client.createSession({
          provider: "codex",
          cwd,
          modeId: "read-only",
          model: CODEX_TEST_MODEL,
          reasoningEffort: CODEX_TEST_REASONING_EFFORT,
        });

        const result = await Promise.race([
          session.run("Provide a concise 2-step plan and do not execute. Reply PLAN_DONE."),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("Plan run timed out")), 60000)
          ),
        ]);

        const info = await session.getRuntimeInfo();
        const sawCollaborationMode = Boolean(info.extra?.collaborationMode);
        await session.close();

        const sawTodo = result.timeline.some(
          (item) => item.type === "todo" && item.items.length > 0
        );
        expect(sawTodo).toBe(true);
        expect(sawCollaborationMode).toBe(true);
      } finally {
        cleanup();
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    120000
  );

  test.runIf(isCodexInstalled())("file change approval flow requests permission and applies change", async () => {
    const cleanup = useTempCodexSessionDir();
    const cwd = tmpCwd("codex-file-approval-");
    const targetPath = path.join(cwd, "approval-test.txt");

    try {
        const client = new CodexAppServerAgentClient(logger);
        const session = await client.createSession({
          provider: "codex",
          cwd,
          modeId: "full-access",
          approvalPolicy: "on-request",
          model: CODEX_TEST_MODEL,
          reasoningEffort: CODEX_TEST_REASONING_EFFORT,
        });

      let sawPermission = false;
      let captured: AgentPermissionRequest | null = null;
      let sawPermissionResolved = false;
      const timelineItems: AgentTimelineItem[] = [];

      const patch = [
        "*** Begin Patch",
        "*** Add File: approval-test.txt",
        "+ok",
        "*** End Patch",
      ].join("\\n");
      const events = session.stream(
        [
          "Use the apply_patch tool and nothing else.",
          "If you need approval before writing files, request approval first.",
          "Do not respond with any message until the apply_patch tool completes.",
          "Apply the following patch exactly:",
          patch,
          "After approval, reply FILE_DONE.",
        ].join("\\n")
      );

      let failure: string | null = null;
      for await (const event of events) {
        if (event.type === "permission_requested" && event.request.name === "CodexFileChange") {
          sawPermission = true;
          captured = event.request;
          await session.respondToPermission(event.request.id, { behavior: "allow" });
        }
        if (
          event.type === "permission_resolved" &&
          captured &&
          event.requestId === captured.id &&
          event.resolution.behavior === "allow"
        ) {
          sawPermissionResolved = true;
        }
        if (event.type === "timeline" && event.item.type === "tool_call") {
          timelineItems.push(event.item);
        }
        if (event.type === "turn_failed") {
          failure = event.error;
          break;
        }
        if (event.type === "turn_completed") {
          break;
        }
      }

      await session.close();

      if (failure) {
        throw new Error(failure);
      }
      if (captured) {
        expect(sawPermissionResolved).toBe(true);
      }
      expect(readFileSync(targetPath, "utf8").trim()).toBe("ok");
    } finally {
      cleanup();
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 60000);

  test.runIf(isCodexInstalled())("tool approval flow requests user input for app tools", async () => {
    const cleanup = useTempCodexSessionDir();
    const cwd = tmpCwd("codex-tool-approval-");

    try {
      const client = new CodexAppServerAgentClient(logger);
      const session = await client.createSession({
        provider: "codex",
        cwd,
        modeId: "auto",
        model: CODEX_TEST_MODEL,
        reasoningEffort: CODEX_TEST_REASONING_EFFORT,
      });

      await session.connect();
      const rawClient = (session as any).client as { request: (method: string, params?: any) => Promise<any> } | null;
      if (!rawClient) {
        throw new Error("Codex app-server client unavailable for app/list");
      }
      const appsResult = await rawClient.request("app/list", { cursor: null, limit: 10 });
      const apps = Array.isArray(appsResult?.data) ? appsResult.data : [];
      const app = apps.find((entry: any) => entry?.isAccessible) ?? apps[0];
      if (!app) {
        await session.close();
        return;
      }

      const input = [
        { type: "text", text: `$${app.id} Perform a minimal action and wait for approval if required. Reply with TOOL_DONE.` },
        { type: "mention", name: app.name ?? app.id, path: `app://${app.id}` },
      ] as unknown as AgentPromptContentBlock[];

      let sawPermission = false;
      let captured: AgentPermissionRequest | null = null;
      let sawPermissionResolved = false;
      let failure: string | null = null;
      const timelineItems: AgentTimelineItem[] = [];

      for await (const event of session.stream(input)) {
        if (event.type === "permission_requested" && event.request.name === "CodexTool") {
          sawPermission = true;
          captured = event.request;
          await session.respondToPermission(event.request.id, { behavior: "allow" });
        }
        if (
          event.type === "permission_resolved" &&
          captured &&
          event.requestId === captured.id &&
          event.resolution.behavior === "allow"
        ) {
          sawPermissionResolved = true;
        }
        if (event.type === "timeline" && event.item.type === "tool_call") {
          timelineItems.push(event.item);
        }
        if (event.type === "turn_failed") {
          failure = event.error;
          break;
        }
        if (event.type === "turn_completed") {
          break;
        }
      }

      await session.close();

      if (failure) {
        throw new Error(failure);
      }
      if (captured) {
        expect(sawPermissionResolved).toBe(true);
      }
      expect(sawPermission || timelineItems.length > 0).toBe(true);
      if (captured) {
        expect(Array.isArray(captured?.metadata?.questions)).toBe(true);
      }
    } finally {
      cleanup();
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 90000);
});
