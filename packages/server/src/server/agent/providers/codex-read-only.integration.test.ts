import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { CodexAppServerAgentClient } from "./codex-app-server-agent.js";
import { CodexAppServerClient } from "./codex/app-server-transport.js";
import { prepareReadOnlyCodexRuntime, READ_ONLY_CODEX_FLAGS } from "./codex/read-only.js";
import { findExecutable } from "../../../executable-resolution/executable-resolution.js";
import { resolveProviderLaunch } from "../provider-launch-config.js";
import { asInternals } from "../../test-utils/class-mocks.js";
import { AgentManager } from "../agent-manager.js";

test.skipIf(process.platform !== "darwin")(
  "isolated native Codex persists, resumes, archives and restores its own conversation",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "paseo-native-readonly-")));
    const cwd = join(root, "workspace");
    const sourceHome = join(root, "empty-source-home");
    const stateRoot = join(root, "state");
    await mkdir(cwd);
    await mkdir(sourceHome);
    const agentId = "8ea1cec9-1e09-477c-82e5-ea4142f09f19";
    const writer = join(root, "mcp-writer.mjs");
    const marker = join(stateRoot, agentId, "mcp-started");
    await writeFile(
      writer,
      "import {writeFileSync} from 'node:fs';writeFileSync(" +
        JSON.stringify(marker) +
        ",'should never start');",
    );
    await writeFile(
      join(sourceHome, "config.toml"),
      "[mcp_servers.user_writer]\ncommand=" +
        JSON.stringify(process.execPath) +
        "\nargs=[" +
        JSON.stringify(writer) +
        "]\n",
    );
    const runtimeSettings = {
      command: {
        mode: "append" as const,
        args: [
          "-c",
          'model_provider="offline_probe"',
          "-c",
          'model_providers.offline_probe={name="Offline persistence probe",base_url="http://127.0.0.1:1/v1",wire_api="responses",requires_openai_auth=false,request_max_retries=0,stream_max_retries=0}',
          "-c",
          "mcp_servers.inherited_writer={command=" +
            JSON.stringify(process.execPath) +
            ",args=[" +
            JSON.stringify(writer) +
            "]}",
          "-c",
          'mcp_servers.remote_writer={url="http://127.0.0.1:1/mcp"}',
        ],
      },
      env: { CODEX_HOME: sourceHome },
    };
    const client = new CodexAppServerAgentClient(createTestLogger(), runtimeSettings, {
      readOnlyStateRoot: stateRoot,
    });
    const manager = new AgentManager({
      clients: { codex: client },
      logger: createTestLogger(),
      idFactory: () => "45439bcd-1ef1-40e3-82f0-33e8c981ddc6",
    });
    let session;
    try {
      const launch = await resolveProviderLaunch({
        commandConfig: runtimeSettings.command,
        defaultBinary: "codex",
      });
      expect(launch.args).toContain('model_provider="offline_probe"');
      expect(launch.args).toContain(
        "mcp_servers.inherited_writer={command=" +
          JSON.stringify(process.execPath) +
          ",args=[" +
          JSON.stringify(writer) +
          "]}",
      );
      session = await client.createSession(
        {
          provider: "codex",
          cwd,
          model: "gpt-5",
          thinkingOptionId: "medium",
          writePolicy: "read_only",
        },
        { agentId },
      );
      const native = asInternals<{ client: CodexAppServerClient }>(session).client;
      expect(await native.request("config/read", { cwd })).toMatchObject({
        config: {
          model_provider: "offline_probe",
          model_providers: {
            offline_probe: { base_url: "http://127.0.0.1:1/v1", requires_openai_auth: false },
          },
          mcp_servers: {
            inherited_writer: { command: process.execPath },
            remote_writer: { url: "http://127.0.0.1:1/mcp" },
          },
        },
      });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const originalHandler = asInternals<{
        notificationHandler: (method: string, params: unknown) => void;
      }>(native).notificationHandler;
      const connectionFailure = new Promise<unknown>((resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("Offline fixture did not fail locally")), 5000);
        native.setNotificationHandler((method, params) => {
          originalHandler(method, params);
          if (method === "error") resolve(params);
        });
      });
      try {
        await session.startTurn(
          "Offline fixture: retain this user message without contacting a model.",
        );
        await expect(connectionFailure).resolves.toMatchObject({
          error: { additionalDetails: expect.stringContaining("Connection failed") },
        });
      } finally {
        clearTimeout(timeout);
        native.setNotificationHandler(originalHandler);
      }
      const handle = session.describePersistence();
      expect(
        await native.request("mcpServerStatus/list", { threadId: handle?.sessionId }),
      ).toMatchObject({
        data: [
          { name: "inherited_writer", runtimeStatus: "disabled", tools: {} },
          { name: "remote_writer", runtimeStatus: "disabled", tools: {} },
        ],
      });
      expect(handle?.sessionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      await session.close();
      session = undefined;
      const stateDir = join(stateRoot, agentId);
      await expect(access(join(stateDir, "config.toml"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(join(stateDir, "tmp"))).rejects.toMatchObject({ code: "ENOENT" });
      const rollouts = (await readdir(join(stateDir, "sessions"), { recursive: true })).filter(
        (file) => file.endsWith(".jsonl"),
      );
      expect(rollouts).toHaveLength(1);
      expect(await readFile(join(stateDir, "sessions", rollouts[0]!), "utf8")).toContain(
        "Offline fixture: retain this user message",
      );
      await expect(
        client.resumeSession(
          { ...handle!, sessionId: "00000000-0000-0000-0000-000000000000" },
          undefined,
          { agentId },
        ),
      ).rejects.toThrow();
      await expect(access(join(stateDir, "tmp"))).rejects.toMatchObject({ code: "ENOENT" });
      // resume_agent_request reaches this entry point without a Paseo agent ID.
      const restored = await manager.resumeAgentFromPersistence(handle!);
      expect(restored.id).toBe(agentId);
      expect(restored.persistence?.sessionId).toBe(handle?.sessionId);
      await manager.closeAgent(restored.id);
      session = await client.resumeSession(handle!, undefined, { agentId });
      expect(session.describePersistence()?.sessionId).toBe(handle?.sessionId);
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
      expect(session.describePersistence()?.metadata).toMatchObject({
        writePolicy: "read_only",
        agentId,
      });
      await session.close();
      session = undefined;
      await client.archiveNativeSession(handle!);
      await client.unarchiveNativeSession(handle!);
      session = await client.resumeSession(handle!, undefined, { agentId });
      expect(session.describePersistence()?.sessionId).toBe(handle?.sessionId);
    } finally {
      await session?.close();
      manager.prepareForShutdown();
      await Promise.all(manager.listAgents().map((agent) => manager.closeAgent(agent.id)));
      await manager.flushForShutdown();
      await rm(root, { recursive: true, force: true });
    }
  },
  20000,
);

test.skipIf(process.platform !== "darwin")(
  "native exec-policy allow cannot bypass workspace confinement",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "paseo-native-boundary-")));
    const cwd = join(root, "workspace");
    const source = join(root, "source");
    await mkdir(cwd);
    await mkdir(source);
    const fixture = join(cwd, "input");
    await writeFile(fixture, "original");
    let rpc: CodexAppServerClient | undefined;
    try {
      const runtime = await prepareReadOnlyCodexRuntime({
        agentId: "native-boundary",
        cwd,
        env: { ...process.env, CODEX_HOME: source },
        stateRoot: join(root, "state"),
      });
      const binary = await findExecutable("codex");
      if (!binary)
        throw new Error("Codex CLI is required for the native read-only integration test");
      const rules = join(runtime.stateDir, "allow.rules");
      await writeFile(rules, 'prefix_rule(pattern=["/usr/bin/touch"], decision="allow")\n');
      const child = spawn(
        "/usr/bin/sandbox-exec",
        ["-p", runtime.profile, binary, "app-server", ...READ_ONLY_CODEX_FLAGS],
        { cwd: runtime.stateDir, env: runtime.env, stdio: "pipe", detached: true },
      );
      rpc = new CodexAppServerClient(child, createTestLogger());
      await rpc.request("initialize", {
        clientInfo: { name: "paseo-boundary-fixture", version: "1" },
        capabilities: { experimentalApi: true },
      });
      const run = (command: string[]) =>
        rpc!.request("command/exec", { command, cwd, sandboxPolicy: { type: "dangerFullAccess" } });
      expect(await run(["/bin/cat", fixture])).toMatchObject({ exitCode: 0, stdout: "original" });
      const policy = await run([
        binary,
        "execpolicy",
        "check",
        "--rules",
        rules,
        "--",
        "/usr/bin/touch",
        fixture,
      ]);
      expect(policy).toMatchObject({
        exitCode: 0,
        stdout: expect.stringContaining('"decision":"allow"'),
      });
      expect(await run(["/usr/bin/touch", fixture])).toMatchObject({
        exitCode: 1,
        stderr: expect.stringContaining("Operation not permitted"),
      });
      const internal = join(runtime.stateDir, "internal");
      expect(
        await run([
          process.execPath,
          "-e",
          "require('fs').writeFileSync(" + JSON.stringify(internal) + ",'state')",
        ]),
      ).toMatchObject({ exitCode: 0 });
      expect(await readFile(internal, "utf8")).toBe("state");
      expect(await readFile(fixture, "utf8")).toBe("original");
    } finally {
      await rpc?.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
  20000,
);
