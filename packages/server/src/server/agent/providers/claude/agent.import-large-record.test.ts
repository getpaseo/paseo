import { test, expect, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import pino from "pino";
import { ClaudeAgentClient } from "./agent.js";
import { ConversationImageStore } from "../../conversation-images.js";
import { claudeProjectDirSync } from "./project-dir.js";
import { ProviderSnapshotManager } from "../../provider-snapshot-manager.js";
import type { AgentSession, AgentStreamEvent } from "../../agent-sdk-types.js";

test("lists a session containing a large image record and retains the final prompt", async () => {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-import-image-"));
  try {
    const project = path.join(configDir, "projects", "image-project");
    await fs.mkdir(project, { recursive: true });
    const first = {
      type: "user",
      sessionId: "image-session",
      cwd: "/image-project",
      message: { content: "Describe the image" },
    };
    const image = {
      type: "user",
      sessionId: "image-session",
      cwd: "/image-project",
      message: {
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "a".repeat(5 * 1024 * 1024) },
          },
        ],
      },
    };
    const last = { type: "user", message: { content: "What changed?" } };
    await fs.writeFile(
      path.join(project, "image-session.jsonl"),
      [first, image, last].map((record) => JSON.stringify(record)).join("\n"),
    );
    const client = new ClaudeAgentClient({
      logger: pino({ level: "silent" }),
      runtimeSettings: { env: { CLAUDE_CONFIG_DIR: configDir } },
    });
    const sessions = await client.listImportableSessions({ limit: 1 });
    expect(sessions).toEqual([
      expect.objectContaining({
        providerHandleId: "image-session",
        title: "Describe the image",
        firstPromptPreview: "Describe the image",
        lastPromptPreview: "What changed?",
      }),
    ]);
  } finally {
    await fs.rm(configDir, { recursive: true, force: true });
  }
});

test("imports large native image bytes before bounding the public timeline", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-import-image-bytes-"));
  const configDir = path.join(directory, "claude");
  const cwd = path.join(directory, "repo");
  const sessionId = "large-native-image";
  const bytes = Buffer.alloc(1024 * 1024);
  for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
  const data = bytes.toString("base64");
  const text = "description ".repeat(128 * 1024);
  const store = new ConversationImageStore(path.join(directory, "paseo"));
  const client = new ClaudeAgentClient({
    logger: pino({ level: "silent" }),
    captureUserImages: store.capture.bind(store),
    runtimeSettings: { env: { CLAUDE_CONFIG_DIR: configDir } },
    resolveBinary: async () => process.execPath,
    resolveVersion: async () => "2.1.220",
    queryFactory: () => {
      throw new Error("import must not start a query");
    },
  });
  let session: Awaited<ReturnType<typeof client.resumeSession>> | undefined;
  try {
    const project = claudeProjectDirSync(cwd, { configDir });
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(
      path.join(project, `${sessionId}.jsonl`),
      JSON.stringify({
        type: "user",
        uuid: "native-image-without-binding",
        sessionId,
        cwd,
        message: {
          role: "user",
          content: [
            { type: "text", text },
            { type: "image", source: { type: "base64", media_type: "image/png", data } },
          ],
        },
      }) + "\n",
    );
    session = await client.resumeSession({ provider: "claude", sessionId }, { cwd });
    const history = [];
    for await (const event of session.streamHistory()) {
      if (event.type === "timeline") history.push(event.item);
    }
    expect(history).toHaveLength(1);
    const item = history[0];
    if (item?.type !== "user_message") throw new Error("Expected imported user message");
    const publicItem = await store.normalize("imported-agent", item);
    expect(publicItem.images).toEqual([
      expect.objectContaining({ kind: "stored", mimeType: "image/png", byteSize: bytes.length }),
    ]);
    const image = publicItem.images?.[0];
    if (image?.kind !== "stored") throw new Error("Expected stored native image");
    expect(await store.read(image.id)).toEqual(bytes);
    expect(item).not.toHaveProperty("imageSources");
    expect(publicItem).not.toHaveProperty("imageSources");
    expect(JSON.stringify(publicItem)).not.toContain(data);
    expect(publicItem.text).toContain("…[truncated");
    expect(Buffer.byteLength(JSON.stringify(publicItem))).toBeLessThanOrEqual(256 * 1024);
  } finally {
    await session?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function writeImageReplay(directory: string, count = 6) {
  const cwd = path.join(directory, "repo");
  const configDir = path.join(directory, "claude");
  const sessionId = "many-native-images";
  const project = claudeProjectDirSync(cwd, { configDir });
  const subagents = path.join(project, sessionId, "subagents");
  const workflowRun = "wf_images";
  const expected = new Map<string, Buffer>();
  const parent: string[] = [];
  const child: string[] = [];
  const workflow: string[] = [];
  for (const [scope, entries] of [
    ["parent", parent],
    ["child", child],
    ["workflow", workflow],
  ] as const) {
    for (let index = 0; index < count; index++) {
      const messageId = `${scope}-${index}`;
      const bytes = Buffer.alloc(384 * 1024, expected.size + 1);
      expected.set(messageId, bytes);
      const content = [
        { type: "text", text: messageId },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: bytes.toString("base64") },
        },
      ];
      // Workflow replay excludes its initial internal user prompt, but includes steered prompts.
      const payload =
        scope === "workflow"
          ? {
              type: "attachment",
              attachment: {
                type: "queued_command",
                commandMode: "prompt",
                source_uuid: messageId,
                prompt: content,
              },
            }
          : { type: "user", message: { role: "user", content } };
      entries.push(
        JSON.stringify({
          ...payload,
          uuid: messageId,
          sessionId,
          ...(scope === "parent" ? {} : { isSidechain: true, agentId: `${scope}-agent` }),
          timestamp: "2026-08-06T08:04:46.347Z",
        }),
      );
    }
  }
  parent.push(
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "child-task",
            name: "Task",
            input: { subagent_type: "general-purpose", description: "Read images" },
          },
          {
            type: "tool_use",
            id: "workflow-task",
            name: "Workflow",
            input: { scriptPath: "/tmp/image-workflow.js", args: "{}" },
          },
        ],
      },
    }),
  );
  parent.push(
    JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "child-task", content: "agentId: child-agent\ndone" },
          {
            type: "tool_result",
            tool_use_id: "workflow-task",
            content: `Workflow launched in background.\nRun ID: ${workflowRun}`,
          },
        ],
      },
    }),
  );
  await fs.mkdir(path.join(subagents, "workflows", workflowRun), { recursive: true });
  await fs.mkdir(path.join(project, sessionId, "workflows"), { recursive: true });
  await fs.writeFile(path.join(project, `${sessionId}.jsonl`), parent.join("\n"));
  await fs.writeFile(path.join(subagents, "agent-child-agent.jsonl"), child.join("\n"));
  await fs.writeFile(
    path.join(subagents, "workflows", workflowRun, "agent-workflow-agent.jsonl"),
    workflow.join("\n"),
  );
  await fs.writeFile(
    path.join(project, sessionId, "workflows", `${workflowRun}.json`),
    JSON.stringify({
      runId: workflowRun,
      summary: "Read workflow images",
      status: "completed",
      startTime: 1786003484150,
      timestamp: "2026-08-06T08:04:46.347Z",
    }),
  );
  return { cwd, configDir, sessionId, expected };
}

function assertNoRetainedImageSources(value: unknown): void {
  const serialized = JSON.stringify(value);
  expect(serialized.includes('"imageSources"')).toBe(false);
  // All rows retain small references, rather than encoded source-sized strings.
  expect(Buffer.byteLength(serialized)).toBeLessThan(64 * 1024);
}

async function historyEvents(session: AgentSession): Promise<AgentStreamEvent[]> {
  const events = [];
  for await (const event of session.streamHistory()) events.push(event);
  return events;
}

test("captures parent, child and workflow images before caching and materializing imports", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-image-memory-"));
  let session: AgentSession | undefined;
  let reloaded: AgentSession | undefined;
  let importedSession: AgentSession | undefined;
  try {
    const fixture = await writeImageReplay(directory);
    const home = path.join(directory, "paseo");
    const store = new ConversationImageStore(home);
    const client = new ClaudeAgentClient({
      logger: pino({ level: "silent" }),
      runtimeSettings: { env: { CLAUDE_CONFIG_DIR: fixture.configDir } },
      captureUserImages: store.capture.bind(store),
    });
    session = await client.resumeSession(
      { provider: "claude", sessionId: fixture.sessionId },
      { cwd: fixture.cwd },
    );
    assertNoRetainedImageSources(Reflect.get(session, "persistedHistory"));
    assertNoRetainedImageSources(Reflect.get(session, "persistedProviderSubagentEvents"));
    const events = await historyEvents(session);
    expect(await historyEvents(session)).toEqual([]);
    const imported = await client.importSession(
      { providerHandleId: fixture.sessionId, cwd: fixture.cwd },
      {
        config: { provider: "claude", cwd: fixture.cwd },
        storedConfig: { provider: "claude", cwd: fixture.cwd },
      },
    );
    importedSession = imported.session;
    assertNoRetainedImageSources(imported.timeline);
    assertNoRetainedImageSources(imported.providerSubagentEvents);
    expect(imported.timeline).toEqual(
      events.flatMap((event) =>
        event.type === "timeline"
          ? [{ item: event.item, ...(event.timestamp ? { timestamp: event.timestamp } : {}) }]
          : [],
      ),
    );
    expect(imported.providerSubagentEvents).toEqual(
      events.filter((event) => event.type === "provider_subagent"),
    );
    assertNoRetainedImageSources(events);
    const users = events.flatMap((event) => {
      let item;
      if (event.type === "timeline") item = event.item;
      else if (event.type === "provider_subagent" && event.event.type === "timeline")
        item = event.event.item;
      return item?.type === "user_message" && item.images?.length ? [item] : [];
    });
    expect(users.map((item) => item.messageId).sort()).toEqual([...fixture.expected.keys()].sort());
    const reopened = new ConversationImageStore(home);
    for (const item of users) {
      const bytes = fixture.expected.get(item.messageId ?? "");
      const image = item.images?.[0];
      if (!bytes || image?.kind !== "stored") throw new Error("Missing captured native image");
      expect((await reopened.read(image.id)).equals(bytes)).toBe(true);
    }
    // Capture does not acquire alias authority: only manager normalization binds native IDs.
    expect(
      (
        await reopened.normalize("unbound", {
          type: "user_message",
          text: "",
          messageId: "parent-0",
        })
      ).images,
    ).toBeUndefined();
    reloaded = await client.resumeSession(
      { provider: "claude", sessionId: fixture.sessionId },
      { cwd: fixture.cwd },
    );
    expect(await historyEvents(reloaded)).toEqual(events);
  } finally {
    await session?.close();
    await reloaded?.close();
    await importedSession?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("image replay without a capture capability fails explicitly instead of caching raw sources", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-image-no-capture-"));
  try {
    const fixture = await writeImageReplay(directory, 1);
    const client = new ClaudeAgentClient({
      logger: pino({ level: "silent" }),
      runtimeSettings: { env: { CLAUDE_CONFIG_DIR: fixture.configDir } },
    });
    await expect(
      client.resumeSession(
        { provider: "claude", sessionId: fixture.sessionId },
        { cwd: fixture.cwd },
      ),
    ).rejects.toThrow("Configure captureUserImages");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("capture failure releases sources, continues history and lets manager recover prior bindings", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-image-capture-failure-"));
  let session: AgentSession | undefined;
  try {
    const fixture = await writeImageReplay(directory, 2);
    const store = new ConversationImageStore(path.join(directory, "paseo"));
    const prior = await store.capture([
      {
        kind: "base64",
        mimeType: "image/png",
        data: fixture.expected.get("child-0")!.toString("base64"),
      },
    ]);
    await store.bind("agent", ["child-0"], prior);
    const capture = vi.fn(store.capture.bind(store)).mockImplementationOnce(async () => {
      throw new Error("disk unavailable");
    });
    const warnings: string[] = [];
    const client = new ClaudeAgentClient({
      logger: pino({ level: "warn" }, { write: (line: string) => warnings.push(line) }),
      runtimeSettings: { env: { CLAUDE_CONFIG_DIR: fixture.configDir } },
      captureUserImages: capture,
    });
    session = await client.resumeSession(
      { provider: "claude", sessionId: fixture.sessionId },
      { cwd: fixture.cwd },
    );
    const events = await historyEvents(session);
    assertNoRetainedImageSources(events);
    expect(capture).toHaveBeenCalledTimes(fixture.expected.size);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Unable to retain Claude history images");
    expect(warnings[0]).toContain("disk unavailable");
    const unavailable = events.flatMap((event) => {
      let item;
      if (event.type === "timeline") item = event.item;
      else if (event.type === "provider_subagent" && event.event.type === "timeline")
        item = event.event.item;
      return item?.type === "user_message" && item.images?.[0]?.kind === "unavailable"
        ? [item]
        : [];
    });
    expect(unavailable).toHaveLength(1);
    const failed = unavailable[0]!;
    const laterStored = events.filter(
      (event) =>
        event.type === "timeline" &&
        event.item.type === "user_message" &&
        event.item.images?.[0]?.kind === "stored",
    );
    expect(laterStored.length).toBeGreaterThan(0);
    expect(failed.messageId).toBe("child-0");
    expect((await store.normalize("agent", failed)).images).toEqual(prior);
  } finally {
    await session?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test.each(["claude", "custom-claude"])(
  "snapshot factories forward image capture to %s sessions",
  async (provider) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-image-factory-"));
    let session: AgentSession | undefined;
    let snapshots: ProviderSnapshotManager | undefined;
    try {
      const fixture = await writeImageReplay(directory, 1);
      const store = new ConversationImageStore(path.join(directory, "paseo"));
      const capture = vi.fn(store.capture.bind(store));
      snapshots = new ProviderSnapshotManager({
        logger: pino({ level: "silent" }),
        captureUserImages: capture,
        runtimeSettings: { claude: { env: { CLAUDE_CONFIG_DIR: fixture.configDir } } },
        providerOverrides: { "custom-claude": { extends: "claude", label: "Custom Claude" } },
      });
      const state = snapshots.getAgentManagerProviderState();
      const client = state.clients[provider]!;
      session = await client.resumeSession(
        { provider, sessionId: fixture.sessionId },
        { provider, cwd: fixture.cwd },
      );
      assertNoRetainedImageSources(await historyEvents(session));
      expect(capture).toHaveBeenCalledTimes(fixture.expected.size);
    } finally {
      await session?.close();
      await snapshots?.shutdown();
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);

test("imageless history remains usable without an image capture capability", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-imageless-replay-"));
  let session: AgentSession | undefined;
  try {
    const configDir = path.join(directory, "claude");
    const cwd = path.join(directory, "repo");
    const project = claudeProjectDirSync(cwd, { configDir });
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(
      path.join(project, "imageless.jsonl"),
      JSON.stringify({ type: "user", uuid: "plain", message: { content: "hello" } }),
    );
    const client = new ClaudeAgentClient({
      logger: pino({ level: "silent" }),
      runtimeSettings: { env: { CLAUDE_CONFIG_DIR: configDir } },
    });
    session = await client.resumeSession({ provider: "claude", sessionId: "imageless" }, { cwd });
    expect(await historyEvents(session)).toEqual([
      {
        type: "timeline",
        provider: "claude",
        timestamp: undefined,
        item: { type: "user_message", messageId: "plain", text: "hello" },
      },
    ]);
  } finally {
    await session?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
