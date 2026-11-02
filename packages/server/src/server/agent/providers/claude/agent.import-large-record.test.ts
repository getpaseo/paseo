import { test, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import pino from "pino";
import { ClaudeAgentClient } from "./agent.js";

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
