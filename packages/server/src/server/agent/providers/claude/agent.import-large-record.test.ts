import { test, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import pino from "pino";
import { ClaudeAgentClient } from "./agent.js";
import { ConversationImageStore } from "../../conversation-images.js";
import { claudeProjectDirSync } from "./project-dir.js";

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
  const client = new ClaudeAgentClient({
    logger: pino({ level: "silent" }),
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
    const store = new ConversationImageStore(path.join(directory, "paseo"));
    const publicItem = await store.normalize("imported-agent", item);
    expect(publicItem.images).toEqual([
      expect.objectContaining({ kind: "stored", mimeType: "image/png", byteSize: bytes.length }),
    ]);
    const image = publicItem.images?.[0];
    if (image?.kind !== "stored") throw new Error("Expected stored native image");
    expect(await store.read(image.id)).toEqual(bytes);
    expect(item.imageSources).toEqual([{ kind: "base64", mimeType: "image/png", data }]);
    expect(publicItem).not.toHaveProperty("imageSources");
    expect(JSON.stringify(publicItem)).not.toContain(data);
    expect(publicItem.text).toContain("…[truncated");
    expect(Buffer.byteLength(JSON.stringify(publicItem))).toBeLessThanOrEqual(256 * 1024);
  } finally {
    await session?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
