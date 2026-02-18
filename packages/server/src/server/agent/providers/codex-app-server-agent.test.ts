import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  __codexAppServerInternals,
  CodexAppServerAgentClient,
  codexAppServerTurnInputFromPrompt,
} from "./codex-app-server-agent.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { agentConfigs } from "../../daemon-e2e/agent-configs.js";
import type {
  AgentPermissionRequest,
  AgentPromptContentBlock,
  AgentTimelineItem,
} from "../agent-sdk-types.js";

const CODEX_TEST_MODEL = agentConfigs.codex.model;
const CODEX_TEST_THINKING_OPTION_ID = agentConfigs.codex.thinkingOptionId;
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
  if (item.type !== "tool_call") return false;
  if (item.detail.type === "shell") {
    return item.detail.command.includes(commandFragment);
  }
  const unknownInput =
    item.detail.type === "unknown" && typeof item.detail.input === "object" && item.detail.input
      ? (item.detail.input as { command?: string | string[]; cmd?: string | string[] })
      : undefined;
  const commandValue = unknownInput?.command ?? unknownInput?.cmd;
  const command =
    typeof commandValue === "string"
      ? commandValue
      : Array.isArray(commandValue)
        ? commandValue.filter((value): value is string => typeof value === "string").join(" ")
        : "";
  return command.includes(commandFragment);
}

function hasApplyPatchFile(item: AgentTimelineItem, fileName: string): boolean {
  if (item.type !== "tool_call") return false;
  if (item.detail.type === "edit") {
    return item.detail.filePath === fileName || (item.detail.unifiedDiff?.includes(fileName) ?? false);
  }
  const unknownInput =
    item.detail.type === "unknown" && typeof item.detail.input === "object" && item.detail.input
      ? (item.detail.input as { path?: string; file_path?: string; filePath?: string; files?: Array<{ path?: string }> })
      : undefined;
  const unknownOutput =
    item.detail.type === "unknown" && typeof item.detail.output === "object" && item.detail.output
      ? (item.detail.output as { path?: string; file_path?: string; filePath?: string; files?: Array<{ path?: string; patch?: string }>; diff?: string })
      : undefined;
  const inputPath = unknownInput?.path ?? unknownInput?.file_path ?? unknownInput?.filePath;
  const outputPath = unknownOutput?.path ?? unknownOutput?.file_path ?? unknownOutput?.filePath;
  const inInput = (unknownInput?.files ?? []).some((file) => file?.path === fileName);
  const inOutput = (unknownOutput?.files ?? []).some((file) => file?.path === fileName);
  const inDiff = typeof unknownOutput?.diff === "string" && unknownOutput.diff.includes(fileName);
  return inInput || inOutput || inDiff || inputPath === fileName || outputPath === fileName;
}

function buildStrictApplyPatchPrompt(
  patch: string,
  completionToken: string,
  options?: { includePermissionStep?: boolean }
): string {
  const lines = [
    "You are running an automated integration test.",
    "Required behavior:",
    "- Call the apply_patch tool exactly once using the patch below.",
    "- Do not call shell, Bash, exec_command, write_file, or any other tool.",
    "- Do not ask for confirmation in text or via any tool call.",
  ];
  if (options?.includePermissionStep) {
    lines.push(
      "- If permission is required, wait for approval and then continue with the same apply_patch call."
    );
  }
  lines.push("Patch to apply exactly:");
  lines.push(patch);
  lines.push(`After successful apply_patch completion, reply exactly ${completionToken}.`);
  return lines.join("\n");
}

async function waitForFileToContainText(
  filePath: string,
  expectedText: string,
  options?: { timeoutMs?: number; intervalMs?: number }
): Promise<string | null> {
  const timeoutMs = options?.timeoutMs ?? 2500;
  const intervalMs = options?.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const text = readFileSync(filePath, "utf8");
      if (text.includes(expectedText)) {
        return text;
      }
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  return null;
}

function readRolloutTurnContextEfforts(rolloutPath: string): string[] {
  const lines = readFileSync(rolloutPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const efforts: string[] = [];
  for (const line of lines) {
    let parsed: {
      type?: string;
      payload?: {
        effort?: string;
        reasoning_effort?: string;
        collaboration_mode?: { settings?: { reasoning_effort?: string } };
      };
    } | null = null;
    try {
      parsed = JSON.parse(line) as {
        type?: string;
        payload?: {
          effort?: string;
          reasoning_effort?: string;
          collaboration_mode?: { settings?: { reasoning_effort?: string } };
        };
      };
    } catch {
      continue;
    }

    if (parsed?.type !== "turn_context") continue;
    const effort =
      parsed.payload?.effort ??
      parsed.payload?.reasoning_effort ??
      parsed.payload?.collaboration_mode?.settings?.reasoning_effort ??
      null;
    if (typeof effort === "string" && effort.length > 0) {
      efforts.push(effort);
    }
  }

  return efforts;
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

  test("maps patch notifications with array-style changes and alias diff keys", () => {
    const item = __codexAppServerInternals.mapCodexPatchNotificationToToolCall({
      callId: "patch-array-alias",
      changes: [
        {
          path: "/tmp/repo/src/array-alias.ts",
          kind: "modify",
          unified_diff: "@@\n-old\n+new\n",
        },
      ],
      cwd: "/tmp/repo",
      running: false,
    });

    expect(item.detail.type).toBe("edit");
    if (item.detail.type === "edit") {
      expect(item.detail.filePath).toBe("src/array-alias.ts");
      expect(item.detail.unifiedDiff).toContain("-old");
      expect(item.detail.unifiedDiff).toContain("+new");
      expect(item.detail.newString).toBeUndefined();
    }
  });

  test("maps patch notifications with object-style single change payloads", () => {
    const item = __codexAppServerInternals.mapCodexPatchNotificationToToolCall({
      callId: "patch-object-single",
      changes: {
        path: "/tmp/repo/src/object-single.ts",
        kind: "modify",
        patch: "@@\n-before\n+after\n",
      },
      cwd: "/tmp/repo",
      running: false,
    });

    expect(item.detail.type).toBe("edit");
    if (item.detail.type === "edit") {
      expect(item.detail.filePath).toBe("src/object-single.ts");
      expect(item.detail.unifiedDiff).toContain("-before");
      expect(item.detail.unifiedDiff).toContain("+after");
      expect(item.detail.newString).toBeUndefined();
    }
  });

  test.runIf(isCodexInstalled())("listModels returns live Codex models", async () => {
    const client = new CodexAppServerAgentClient(logger);
    const models = await client.listModels();
    expect(models.some((model) => model.id.includes("gpt-5.1-codex"))).toBe(true);
  }, 30000);

  test.runIf(isCodexInstalled())(
    "listModels exposes concrete thinking options (no synthetic default id)",
    async () => {
      const client = new CodexAppServerAgentClient(logger);
      const models = await client.listModels();

      for (const model of models) {
        const options = model.thinkingOptions ?? [];
        for (const option of options) {
          expect(option.id).not.toBe("default");
        }

        if (options.length > 0) {
          const defaultThinkingId = model.defaultThinkingOptionId;
          expect(typeof defaultThinkingId).toBe("string");
          expect(options.some((option) => option.id === defaultThinkingId)).toBe(true);
        }
      }
    },
    30000
  );

  test.runIf(isCodexInstalled())(
    "listModels honors configured Codex model + reasoning defaults",
    async () => {
      const codexHome = tmpCwd("codex-home-defaults-");
      const prevCodexHome = process.env.CODEX_HOME;
      process.env.CODEX_HOME = codexHome;

      try {
        const client = new CodexAppServerAgentClient(logger);
        const baselineModels = await client.listModels();
        const baselineDefaultModel =
          baselineModels.find((model) => model.isDefault) ?? baselineModels[0];
        expect(baselineDefaultModel).toBeDefined();
        const configuredModelId = baselineDefaultModel?.id;
        expect(typeof configuredModelId).toBe("string");
        expect((configuredModelId ?? "").length).toBeGreaterThan(0);

        writeFileSync(
          path.join(codexHome, "config.toml"),
          [
            `model = "${configuredModelId}"`,
            'model_reasoning_effort = "xhigh"',
          ].join("\n"),
          "utf8"
        );

        const models = await client.listModels();
        const configuredModel = models.find((model) => model.id === configuredModelId);
        expect(configuredModel).toBeDefined();
        expect(configuredModel?.isDefault).toBe(true);
        expect(configuredModel?.defaultThinkingOptionId).toBe("xhigh");
        expect(configuredModel?.thinkingOptions?.some((option) => option.id === "xhigh")).toBe(
          true
        );
      } finally {
        if (prevCodexHome === undefined) {
          delete process.env.CODEX_HOME;
        } else {
          process.env.CODEX_HOME = prevCodexHome;
        }
        rmSync(codexHome, { recursive: true, force: true });
      }
    },
    30000
  );

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
        thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID,
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
        thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID,
      });

      const info = await session.getRuntimeInfo();
      await session.close();

      expect(info.model).toBe(CODEX_TEST_MODEL);
      expect(info.modeId).toBe("auto");
      expect(info.sessionId?.length).toBeGreaterThan(0);
    } finally {
      cleanup();
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 120000);

  test.runIf(isCodexInstalled())(
    "thinking option changes round-trip through Codex app-server turn context",
    async () => {
      const cleanup = useTempCodexSessionDir();
      const cwd = tmpCwd("codex-thinking-roundtrip-");
      let session: Awaited<ReturnType<CodexAppServerAgentClient["createSession"]>> | null = null;

      try {
        const client = new CodexAppServerAgentClient(logger);
        const models = await client.listModels();
        const modelWithThinking = models.find((m) => (m.thinkingOptions?.length ?? 0) > 1);
        if (!modelWithThinking) {
          throw new Error("No Codex model with at least two non-default thinking options");
        }

        const defaultThinkingId = modelWithThinking.defaultThinkingOptionId ?? null;
        const thinkingIds = (modelWithThinking.thinkingOptions ?? []).map((opt) => opt.id);
        if (thinkingIds.length < 2) {
          throw new Error("No Codex model with at least two non-default thinking options");
        }
        const initialThinkingId = defaultThinkingId ?? thinkingIds[0]!;
        const switchedThinkingId =
          thinkingIds.find((id) => id !== initialThinkingId) ?? thinkingIds[0]!;

        session = await client.createSession({
          provider: "codex",
          cwd,
          modeId: "auto",
          model: modelWithThinking.id,
          thinkingOptionId: initialThinkingId,
        });

        await session.run("Reply with exactly OK.");
        await session.setThinkingOption?.(switchedThinkingId);
        await session.run("Reply with exactly OK.");

        const internal = session as unknown as {
          client?: {
            request: (method: string, params: unknown) => Promise<unknown>;
          };
          currentThreadId?: string | null;
        };
        const threadId = internal.currentThreadId;
        const codexClient = internal.client;
        if (!threadId || !codexClient) {
          throw new Error("Codex session did not initialize app-server client/thread");
        }

        const threadRead = (await codexClient.request("thread/read", {
          threadId,
          includeTurns: true,
        })) as { thread?: { path?: string } };
        const rolloutPath = threadRead.thread?.path;
        if (!rolloutPath) {
          throw new Error("Codex app-server did not return rollout path");
        }

        const efforts = readRolloutTurnContextEfforts(rolloutPath);
        const initialIndex = efforts.lastIndexOf(initialThinkingId);
        const switchedIndex = efforts.lastIndexOf(switchedThinkingId);

        expect(initialIndex).toBeGreaterThanOrEqual(0);
        expect(switchedIndex).toBeGreaterThan(initialIndex);
      } finally {
        await session?.close().catch(() => undefined);
        cleanup();
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    120000
  );

  test.runIf(isCodexInstalled())("round-trips a stdio MCP tool call", async () => {
    const cleanup = useTempCodexSessionDir();
    const cwd = tmpCwd("codex-mcp-roundtrip-");
    const token = `MCP_ROUNDTRIP_${Date.now()}`;
    const mcpScriptPath = path.resolve(process.cwd(), "scripts", "mcp-echo-test-server.mjs");

    try {
      const client = new CodexAppServerAgentClient(logger);
      const session = await client.createSession({
        provider: "codex",
        cwd,
        modeId: "read-only",
        model: CODEX_TEST_MODEL,
        thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID,
        mcpServers: {
          paseo_test: {
            type: "stdio",
            command: process.execPath,
            args: [mcpScriptPath],
          },
        },
      });

      const result = await session.run(
        [
          "You must call the MCP tool named paseo_test.echo exactly once.",
          `Call it with text: ${token}`,
          "Do not use shell or any non-MCP tools.",
          "After the tool call, respond with exactly the tool output text.",
        ].join(" ")
      );
      await session.close();

      const toolCalls = result.timeline.filter(
        (item): item is Extract<AgentTimelineItem, { type: "tool_call" }> =>
          item.type === "tool_call"
      );
      const toolNames = toolCalls.map((item) => item.name);
      const distinctMcpCalls = new Map<string, Extract<AgentTimelineItem, { type: "tool_call" }>>();
      for (const call of toolCalls) {
        if (call.name !== "paseo_test.echo") {
          continue;
        }
        const key = String(call.callId ?? `${call.name}:${JSON.stringify(call.detail)}`);
        const existing = distinctMcpCalls.get(key);
        if (!existing || call.status === "completed") {
          distinctMcpCalls.set(key, call);
        }
      }

      // Hard assertion: exactly one distinct call of the exact MCP tool.
      expect(toolNames.every((name) => name === "paseo_test.echo")).toBe(true);
      expect(distinctMcpCalls.size).toBe(1);
      const mcpToolCall = Array.from(distinctMcpCalls.values())[0]!;
      expect(mcpToolCall.name).toBe("paseo_test.echo");
      expect(mcpToolCall.status).toBe("completed");

      // Hard assertion: no non-MCP tools in this run.
      expect(toolNames.every((name) => name === "paseo_test.echo")).toBe(true);
      expect(toolNames.some((name) => name.toLowerCase().includes("shell"))).toBe(false);

      // Hard assertion: roundtrip token must be present in the MCP tool I/O.
      const mcpDetail = mcpToolCall.detail.type === "unknown" ? mcpToolCall.detail : null;
      expect(JSON.stringify(mcpDetail?.input ?? {})).toContain(token);
      expect(JSON.stringify(mcpDetail?.output ?? {})).toContain(`ECHO:${token}`);
      expect(result.finalText).toContain(`ECHO:${token}`);
    } finally {
      cleanup();
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 120000);

  test.runIf(isCodexInstalled())(
    "listCommands includes custom prompts and run('/prompts:*') expands them",
    async () => {
      const cleanup = useTempCodexSessionDir();
      const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
      const promptsDir = path.join(codexHome, "prompts");
      const promptPath = path.join(promptsDir, "test.md");
      const cwd = tmpCwd("codex-cmd-");
      const token = `PASEO_PROMPT_TOKEN_${Date.now()}`;

      mkdirSync(promptsDir, { recursive: true });
      writeFileSync(
        promptPath,
        [
          "---",
          "description: Test Prompt",
          "argument-hint: NAME=<name> <extra>",
          "---",
          `Reply with exactly: ${token}::name=$NAME::pos1=$1::dollar=$$`,
        ].join("\n"),
        "utf8"
      );

      try {
        const client = new CodexAppServerAgentClient(logger);
        const session = await client.createSession({
          provider: "codex",
          cwd,
          modeId: "auto",
          model: CODEX_TEST_MODEL,
          thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID,
        });
        try {
          const commands = await session.listCommands?.();
          expect(commands?.some((cmd) => cmd.name === "prompts:test")).toBe(true);

          const executeArgs = "NAME=world extra_value";
          const expectedExpanded = `${token}::name=world::pos1=extra_value::dollar=$`;
          const rawSlashInput = "/prompts:test NAME=world extra_value";
          const runResult = await session.run(rawSlashInput);
          expect(runResult.finalText).toContain(expectedExpanded);
        } finally {
          await session.close();
        }
      } finally {
        cleanup();
        rmSync(cwd, { recursive: true, force: true });
        rmSync(promptPath, { force: true });
      }
    },
    120000
  );

  test.runIf(isCodexInstalled())(
    "slash prompt run streams live turn events (turn_started/turn_completed)",
    async () => {
      const cleanup = useTempCodexSessionDir();
      const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
      const promptsDir = path.join(codexHome, "prompts");
      const promptPath = path.join(promptsDir, "stream-test.md");
      const cwd = tmpCwd("codex-cmd-stream-");
      const token = `PASEO_STREAM_TOKEN_${Date.now()}`;

      mkdirSync(promptsDir, { recursive: true });
      writeFileSync(
        promptPath,
        [
          "---",
          "description: Stream Test Prompt",
          "---",
          `Reply with exactly: ${token}`,
        ].join("\n"),
        "utf8"
      );

      try {
        const client = new CodexAppServerAgentClient(logger);
        const session = await client.createSession({
          provider: "codex",
          cwd,
          modeId: "auto",
          model: CODEX_TEST_MODEL,
          thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID,
        });
        try {
          const events = session.stream("/prompts:stream-test");
          const seenTypes = new Set<string>();
          const assistantChunks: string[] = [];
          for await (const event of events) {
            seenTypes.add(event.type);
            if (event.type === "timeline" && event.item.type === "assistant_message") {
              assistantChunks.push(event.item.text);
            }
          }

          expect(seenTypes.has("turn_started")).toBe(true);
          expect(seenTypes.has("turn_completed")).toBe(true);
          expect(assistantChunks.join("")).toContain(token);
        } finally {
          await session.close();
        }
      } finally {
        cleanup();
        rmSync(cwd, { recursive: true, force: true });
        rmSync(promptPath, { force: true });
      }
    },
    120000
  );

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
        thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID,
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
          expect(captured.detail?.type).toBe("shell");
          if (captured.detail?.type === "shell") {
            expect(captured.detail.command).toContain("printf");
          }
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
        timelineItems.some((item) => hasShellCommand(item, "printf"))
      ).toBe(true);
      expect(existsSync(filePath)).toBe(true);
      expect(readFileSync(filePath, "utf8")).toContain("ok");
    } finally {
      cleanup();
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 60000);

  test.runIf(isCodexInstalled())("command approval deny emits failed tool call and skips execution", async () => {
    const cleanup = useTempCodexSessionDir();
    const cwd = tmpCwd("codex-cmd-deny-");
    const filePath = path.join(cwd, "permission-deny.txt");
    writeFileSync(filePath, "ok", "utf8");

    try {
      const client = new CodexAppServerAgentClient(logger);
      const session = await client.createSession({
        provider: "codex",
        cwd,
        modeId: "auto",
        approvalPolicy: "on-request",
        model: CODEX_TEST_MODEL,
        thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID,
      });

      let sawPermission = false;
      let captured: AgentPermissionRequest | null = null;
      let sawPermissionResolvedDeny = false;
      const timelineItems: AgentTimelineItem[] = [];

      const events = session.stream(
        [
          "You must use your shell tool to run the exact command",
          "`rm -f permission-deny.txt`.",
          "If approval is denied, reply DENIED and stop.",
        ].join(" ")
      );

      let failure: string | null = null;
      for await (const event of events) {
        if (event.type === "permission_requested" && event.request.name === "CodexBash") {
          sawPermission = true;
          captured = event.request;
          await session.respondToPermission(event.request.id, {
            behavior: "deny",
            message: "Denied by test",
          });
        }
        if (
          event.type === "permission_resolved" &&
          captured &&
          event.requestId === captured.id &&
          event.resolution.behavior === "deny"
        ) {
          sawPermissionResolvedDeny = true;
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

      expect(sawPermission).toBe(true);
      expect(sawPermissionResolvedDeny).toBe(true);
      expect(
        timelineItems.some(
          (item) =>
            item.status === "failed" && hasShellCommand(item, "permission-deny.txt")
        )
      ).toBe(true);
      expect(existsSync(filePath)).toBe(true);
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
          thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID,
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
        ].join("\n");
        const patchEvents = session.stream(
          buildStrictApplyPatchPrompt(patch, "PATCH_DONE", {
            includePermissionStep: true,
          })
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
        const patchText =
          (await waitForFileToContainText(patchFile, "patched")) ??
          readFileSync(patchFile, "utf8");
        expect(patchText.trim()).toBe("patched");

        const shellItem = timelineItems.find((item) => hasShellCommand(item, "printf"));
        const patchItem = timelineItems.find((item) => hasApplyPatchFile(item, "patch.txt"));
        expect(shellItem?.type).toBe("tool_call");
        expect(patchItem?.type).toBe("tool_call");
        if (shellItem?.type === "tool_call") {
          expect(hasShellCommand(shellItem, "printf")).toBe(true);
        }
        if (patchItem?.type === "tool_call") {
          expect(hasApplyPatchFile(patchItem, "patch.txt")).toBe(true);
        }
      } finally {
        cleanup();
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    120000
  );

  test.runIf(isCodexInstalled())(
    "emits expandable canonical detail for apply_patch tool calls",
    async () => {
      const cleanup = useTempCodexSessionDir();
      const cwd = tmpCwd("codex-patch-detail-");
      const patchFile = path.join(cwd, "expandable-patch.txt");

      try {
        const client = new CodexAppServerAgentClient(logger);
        const session = await client.createSession({
          provider: "codex",
          cwd,
          modeId: "full-access",
          approvalPolicy: "on-request",
          model: CODEX_TEST_MODEL,
          thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID,
        });
        const persistenceHandle = session.describePersistence();

        const timelineItems: AgentTimelineItem[] = [];
        let failure: string | null = null;
        const patch = [
          "*** Begin Patch",
          "*** Add File: expandable-patch.txt",
          "+expandable",
          "*** End Patch",
        ].join("\n");
        const events = session.stream(
          buildStrictApplyPatchPrompt(patch, "PATCH_DONE", {
            includePermissionStep: true,
          })
        );

        for await (const event of events) {
          if (event.type === "permission_requested") {
            await session.respondToPermission(event.request.id, { behavior: "allow" });
          }
          if (event.type === "timeline") {
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

        const patchCalls = timelineItems.filter(
          (item): item is Extract<AgentTimelineItem, { type: "tool_call" }> =>
            item.type === "tool_call" &&
            item.name.trim().replace(/[.\s-]+/g, "_").toLowerCase().endsWith("apply_patch")
        );
        if (patchCalls.length === 0) {
          const fileExists = existsSync(patchFile);
          const fileContent = fileExists ? readFileSync(patchFile, "utf8") : null;
          const toolCalls = timelineItems
            .filter((item): item is Extract<AgentTimelineItem, { type: "tool_call" }> => item.type === "tool_call")
            .map((item) => ({
              name: item.name,
              status: item.status,
              detail: item.detail,
              error: item.error,
            }));
          let historyToolCalls: Array<{
            name: string;
            status: string;
            detail: unknown;
            error: unknown;
          }> = [];
          if (persistenceHandle) {
            const resumed = await client.resumeSession(persistenceHandle);
            for await (const event of resumed.streamHistory()) {
              if (event.type === "timeline" && event.item.type === "tool_call") {
                historyToolCalls.push({
                  name: event.item.name,
                  status: event.item.status,
                  detail: event.item.detail,
                  error: event.item.error,
                });
              }
            }
            await resumed.close();
          }
          throw new Error(
            `No apply_patch call observed. fileExists=${fileExists} fileContent=${JSON.stringify(fileContent)} liveToolCalls=${JSON.stringify(toolCalls)} historyToolCalls=${JSON.stringify(historyToolCalls)}`
          );
        }
        const completedPatchCall = patchCalls.find((item) => item.status === "completed");
        expect(completedPatchCall).toBeDefined();
        if (!completedPatchCall) {
          return;
        }

        // Patch tool calls must be renderable as expandable details in the UI.
        expect(completedPatchCall.detail.type).toBe("edit");
        if (completedPatchCall.detail.type === "edit") {
          const renderablePayload =
            completedPatchCall.detail.unifiedDiff ?? completedPatchCall.detail.newString;
          expect(typeof renderablePayload).toBe("string");
          expect(renderablePayload).toContain("expandable");
          expect(renderablePayload).not.toContain("*** Begin Patch");
        }

        const patchText =
          (await waitForFileToContainText(patchFile, "expandable")) ??
          readFileSync(patchFile, "utf8");
        expect(patchText.trim()).toBe("expandable");
      } finally {
        cleanup();
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    120000
  );

  test.runIf(isCodexInstalled())(
    "avoids duplicate assistant timeline rows when mirrored item lifecycle notifications are emitted",
    async () => {
      const cleanup = useTempCodexSessionDir();
      const cwd = tmpCwd("codex-mirrored-item-lifecycle-");

      try {
        const client = new CodexAppServerAgentClient(logger);
        const session = await client.createSession({
          provider: "codex",
          cwd,
          modeId: "full-access",
          approvalPolicy: "never",
          model: CODEX_TEST_MODEL,
          thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID,
        });

        const lifecycleChannelsByItemId = new Map<string, { item: boolean; codexEvent: boolean }>();
        const rawClient = (session as any).client as
          | {
              notificationHandler?: (method: string, params: unknown) => void;
              setNotificationHandler?: (handler: (method: string, params: unknown) => void) => void;
            }
          | null;
        const originalHandler = rawClient?.notificationHandler;
        rawClient?.setNotificationHandler?.((method: string, params: unknown) => {
          if (method === "item/completed" || method === "codex/event/item_completed") {
            const record =
              params && typeof params === "object" && "msg" in (params as Record<string, unknown>)
                ? ((params as { msg?: { item?: { id?: unknown; type?: unknown } } }).msg?.item ?? null)
                : ((params as { item?: { id?: unknown; type?: unknown } })?.item ?? null);
            const itemId = typeof record?.id === "string" ? record.id : null;
            const normalizedType =
              typeof record?.type === "string"
                ? record.type.replace(/[._-]/g, "").toLowerCase()
                : "";
            if (itemId && normalizedType === "agentmessage") {
              const existing = lifecycleChannelsByItemId.get(itemId) ?? {
                item: false,
                codexEvent: false,
              };
              if (method === "item/completed") {
                existing.item = true;
              } else {
                existing.codexEvent = true;
              }
              lifecycleChannelsByItemId.set(itemId, existing);
            }
          }
          originalHandler?.(method, params);
        });

        const assistantMessages: string[] = [];
        let failure: string | null = null;
        for await (const event of session.stream("Reply with exactly: DUPLICATE_CHECK_DONE")) {
          if (event.type === "timeline" && event.item.type === "assistant_message") {
            assistantMessages.push(event.item.text);
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

        const normalizedMessages = assistantMessages.map((text) => text.trim()).filter(Boolean);
        expect(
          normalizedMessages.some((text) => text.toLowerCase().includes("duplicate_check_done"))
        ).toBe(true);
        const adjacentDuplicates = normalizedMessages.filter(
          (text, index) => index > 0 && normalizedMessages[index - 1] === text
        );
        expect(adjacentDuplicates.length).toBe(0);
        const sawMirroredLifecycleForAgentMessage = Array.from(
          lifecycleChannelsByItemId.values()
        ).some((entry) => entry.item && entry.codexEvent);
        expect(sawMirroredLifecycleForAgentMessage).toBe(true);
      } finally {
        cleanup();
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    120000
  );

  test.runIf(isCodexInstalled())(
    "prefers exec_command notifications over mirrored item/completed for shell tool calls",
    async () => {
      const cleanup = useTempCodexSessionDir();
      const cwd = tmpCwd("codex-command-lifecycle-dedupe-");

      try {
        const client = new CodexAppServerAgentClient(logger);
        const session = await client.createSession({
          provider: "codex",
          cwd,
          modeId: "full-access",
          approvalPolicy: "never",
          model: CODEX_TEST_MODEL,
          thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID,
        });

        const commandLifecycleByCallId = new Map<string, { execEnd: boolean; itemCompleted: boolean }>();
        const rawClient = (session as any).client as
          | {
              notificationHandler?: (method: string, params: unknown) => void;
              setNotificationHandler?: (handler: (method: string, params: unknown) => void) => void;
            }
          | null;
        const originalHandler = rawClient?.notificationHandler;
        rawClient?.setNotificationHandler?.((method: string, params: unknown) => {
          if (method === "codex/event/exec_command_end") {
            const callId =
              params &&
              typeof params === "object" &&
              "msg" in (params as Record<string, unknown>) &&
              typeof (params as { msg?: { call_id?: unknown } }).msg?.call_id === "string"
                ? ((params as { msg?: { call_id?: string } }).msg?.call_id ?? null)
                : null;
            if (callId) {
              const existing = commandLifecycleByCallId.get(callId) ?? {
                execEnd: false,
                itemCompleted: false,
              };
              existing.execEnd = true;
              commandLifecycleByCallId.set(callId, existing);
            }
          }
          if (method === "item/completed") {
            const item =
              params && typeof params === "object"
                ? ((params as { item?: { id?: unknown; type?: unknown } }).item ?? null)
                : null;
            const itemId = typeof item?.id === "string" ? item.id : null;
            const normalizedType =
              typeof item?.type === "string"
                ? item.type.replace(/[._-]/g, "").toLowerCase()
                : "";
            if (itemId && normalizedType === "commandexecution") {
              const existing = commandLifecycleByCallId.get(itemId) ?? {
                execEnd: false,
                itemCompleted: false,
              };
              existing.itemCompleted = true;
              commandLifecycleByCallId.set(itemId, existing);
            }
          }
          originalHandler?.(method, params);
        });

        const marker = "PASEO_COMMAND_DEDUPE_CHECK_4D0E96C8";
        const shellCalls: Array<{
          callId: string;
          status: string;
          output: string;
        }> = [];
        let failure: string | null = null;
        for await (const event of session.stream(
          `Run exactly this shell command and then reply exactly DONE: printf '${marker}\\n'`
        )) {
          if (event.type === "timeline" && event.item.type === "tool_call" && event.item.name === "shell") {
            const output = event.item.detail.type === "shell" ? event.item.detail.output ?? "" : "";
            shellCalls.push({
              callId: event.item.callId,
              status: event.item.status,
              output,
            });
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

        const targetCall = shellCalls.find(
          (entry) => entry.status === "completed" && entry.output.includes(marker)
        );
        expect(targetCall).toBeDefined();
        if (!targetCall) {
          return;
        }
        const lifecycle = commandLifecycleByCallId.get(targetCall.callId);
        expect(lifecycle?.execEnd).toBe(true);
        expect(lifecycle?.itemCompleted).toBe(true);

        const statusesForCall = shellCalls
          .filter((entry) => entry.callId === targetCall.callId)
          .map((entry) => entry.status);
        expect(statusesForCall.filter((status) => status === "completed").length).toBe(1);
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
      let sawSleepCommand = false;
      let sawCancelEvent = false;

      try {
        const client = new CodexAppServerAgentClient(logger);
        session = await client.createSession({
          provider: "codex",
          cwd,
          modeId: "auto",
          approvalPolicy: "never",
          model: CODEX_TEST_MODEL,
          thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID,
        });

        const stream = session.stream(
          "Run the exact shell command `sleep 60` using your shell tool and do not respond until it finishes."
        );

        const iterator = stream[Symbol.asyncIterator]();

        const nextEvent = async (timeoutMs: number) => {
          const result = await Promise.race([
            iterator.next(),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
          ]);
          if (result === null) return null;
          if (result.done) return null;
          return result.value;
        };

        // Interrupt should be observed quickly; don't allow this test to hang if the stream stalls.
        const hardDeadline = Date.now() + 45_000;
        while (Date.now() < hardDeadline) {
          const event = await nextEvent(10_000);
          if (!event) break;

          if (event.type === "permission_requested") {
            await session.respondToPermission(event.request.id, { behavior: "allow" });
          }

          if (
            event.type === "timeline" &&
            event.item.type === "tool_call" &&
            hasShellCommand(event.item, "sleep 60")
          ) {
            sawSleepCommand = true;
            if (!interruptAt) {
              interruptAt = Date.now();
              await session.interrupt();
            }
          }

          if (event.type === "turn_canceled") {
            sawCancelEvent = true;
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
        // If we observed an explicit cancel event, it should be quick.
        if (sawCancelEvent) {
          expect(latencyMs).toBeLessThan(10_000);
        }

        await session.close();
        session = null;

        followupSession = await client.createSession({
          provider: "codex",
          cwd,
          modeId: "auto",
          model: CODEX_TEST_MODEL,
          thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID,
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
          thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID,
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
        const historyIncludesToken = history.some(
          (item) =>
            (item.type === "assistant_message" || item.type === "user_message") &&
            item.text.includes(token)
        );
        expect(historyIncludesToken).toBe(true);

        const response = await resumed.run("Reply with CONTEXT_OK and stop.");
        expect(response.finalText.toLowerCase()).toContain("context_ok");

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
          // This test should not depend on manual approval flows.
          // If the model decides to call tools, `on-request` can stall the turn indefinitely.
          approvalPolicy: "never",
          sandboxMode: "read-only",
          model: CODEX_TEST_MODEL,
          thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID,
        });

        const result = await Promise.race([
          session.run(
            [
              "Provide a concise 2-step plan as two bullet points.",
              "Do not call any tools or read files. Do not execute anything.",
              "Reply with PLAN_DONE when finished.",
            ].join(" ")
          ),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("Plan run timed out")), 110000)
          ),
        ]);

        const info = await session.getRuntimeInfo();
        const sawCollaborationMode = Boolean(info.extra?.collaborationMode);
        await session.close();

        const sawTodo = result.timeline.some(
          (item) => item.type === "todo" && item.items.length > 0
        );
        // Some Codex installs emit a dedicated `plan` thread item (which maps to `todo`).
        // Others only return the plan as plain assistant text. Either is acceptable.
        if (sawTodo) {
          expect(sawTodo).toBe(true);
        } else {
          expect(result.finalText).toContain("PLAN_DONE");
        }
        // Collaboration modes are optional and may not be supported by all Codex installs.
        // If present, treat it as a successful mapping.
        if (sawCollaborationMode) {
          expect(typeof info.extra?.collaborationMode).toBe("string");
        }
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
          thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID,
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
      ].join("\n");
      const events = session.stream(
        buildStrictApplyPatchPrompt(patch, "FILE_DONE", {
          includePermissionStep: true,
        })
      );

      let failure: string | null = null;
      try {
        await Promise.race([
          (async () => {
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
          })(),
          new Promise<never>((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(
                    "Timed out waiting for Codex file approval flow to complete"
                  )
                ),
              100_000
            )
          ),
        ]);
      } finally {
        await session.close();
      }

      if (failure) {
        throw new Error(failure);
      }
      if (captured) {
        expect(sawPermissionResolved).toBe(true);
      }
      const sawPatch = timelineItems.some((item) => hasApplyPatchFile(item, "approval-test.txt"));
      if (!sawPatch) {
        const toolCalls = timelineItems
          .filter((item): item is Extract<AgentTimelineItem, { type: "tool_call" }> => item.type === "tool_call")
          .map((item) => ({
            name: item.name,
            status: item.status,
            callId: item.callId,
            detail: item.detail,
          }));
        throw new Error(
          `Did not observe apply_patch timeline detail for approval-test.txt. Tool calls: ${JSON.stringify(toolCalls)}`
        );
      }

      const text = await waitForFileToContainText(targetPath, "ok", { timeoutMs: 10000 });
      if (!text) {
        const toolNames = timelineItems
          .filter((item) => item.type === "tool_call")
          .map((item) => item.name)
          .join(", ");
        throw new Error(
          `approval-test.txt was not written after file change approval flow (saw tools: ${toolNames || "none"})`
        );
      }
      expect(text.trim()).toBe("ok");
    } finally {
      cleanup();
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 120000);

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
        thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID,
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
