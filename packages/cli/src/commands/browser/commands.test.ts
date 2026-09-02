import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const connectToDaemon = vi.fn();

vi.mock("../../utils/client.js", () => ({
  connectToDaemon: (...args: unknown[]) => connectToDaemon(...args),
  getDaemonHost: () => "localhost:6767",
}));

const {
  runClickCommand,
  runEvaluateCommand,
  runScreenshotCommand,
  runTabsCommand,
  runUploadCommand,
  runWaitCommand,
} = await import("./commands.js");

const BROWSER_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_DIR = "/repo";
const WORKSPACE_ID = "wks_workspace_a";
const NOOP_COMMAND = {} as Command;

interface ExecutedCall {
  tool: string;
  input?: Record<string, unknown>;
  cwd?: string;
  workspaceId?: string;
}

let calls: ExecutedCall[];

function stubDaemon(result: {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  structuredContent?: unknown;
}): void {
  calls = [];
  connectToDaemon.mockResolvedValue({
    fetchWorkspaces: async () => ({
      entries: [{ id: WORKSPACE_ID, workspaceDirectory: WORKSPACE_DIR }],
    }),
    executeBrowserTool: async (call: ExecutedCall) => {
      calls.push(call);
      return { requestId: "req-1", result };
    },
    close: async () => {},
  });
}

function successResult(text: string, result: Record<string, unknown>) {
  return {
    content: [{ type: "text", text }],
    structuredContent: { ok: true, result },
  };
}

beforeEach(() => {
  stubDaemon(successResult("ok", { command: "click", browserId: BROWSER_ID }));
});

afterEach(() => {
  connectToDaemon.mockReset();
});

describe("browser CLI tool mapping", () => {
  it("sends click modifiers and button through to browser_click", async () => {
    await runClickCommand(
      BROWSER_ID,
      "@e1",
      {
        cwd: WORKSPACE_DIR,
        button: "right",
        doubleClick: true,
        modifiers: ["Shift", "Meta"],
      },
      NOOP_COMMAND,
    );

    expect(calls).toEqual([
      {
        tool: "browser_click",
        input: {
          browserId: BROWSER_ID,
          ref: "@e1",
          button: "right",
          doubleClick: true,
          modifiers: ["Shift", "Meta"],
        },
        cwd: WORKSPACE_DIR,
        workspaceId: WORKSPACE_ID,
      },
    ]);
  });

  it("renames --timeout to the timeoutMs the browser_wait tool expects", async () => {
    stubDaemon(successResult("Browser wait matched text.", { command: "wait" }));

    await runWaitCommand(
      BROWSER_ID,
      { cwd: WORKSPACE_DIR, text: "Example", timeout: "5000" },
      NOOP_COMMAND,
    );

    expect(calls[0]?.input).toEqual({
      browserId: BROWSER_ID,
      text: "Example",
      timeoutMs: 5000,
    });
  });

  it("rejects a non-numeric --timeout before contacting the daemon", async () => {
    await expect(
      runWaitCommand(BROWSER_ID, { cwd: WORKSPACE_DIR, text: "x", timeout: "soon" }, NOOP_COMMAND),
    ).rejects.toMatchObject({ code: "INVALID_NUMBER" });
    expect(calls).toEqual([]);
  });

  it("passes the evaluate body under the tool's `function` key", async () => {
    stubDaemon(successResult("Browser evaluate returned:\n1", { command: "evaluate" }));

    await runEvaluateCommand(
      BROWSER_ID,
      "() => document.title",
      { cwd: WORKSPACE_DIR, ref: "@e2" },
      NOOP_COMMAND,
    );

    expect(calls[0]).toMatchObject({
      tool: "browser_evaluate",
      input: { browserId: BROWSER_ID, function: "() => document.title", ref: "@e2" },
    });
  });

  it("resolves upload paths to absolute paths for the daemon", async () => {
    stubDaemon(successResult("Uploaded 1 file(s) to browser element @e3.", { command: "upload" }));

    await runUploadCommand(
      BROWSER_ID,
      "@e3",
      ["relative/fixture.txt"],
      { cwd: WORKSPACE_DIR },
      NOOP_COMMAND,
    );

    expect(calls[0]?.input?.filePaths).toEqual([resolve("relative/fixture.txt")]);
  });

  it("turns the list_tabs payload into one row per tab", async () => {
    stubDaemon(
      successResult("Found 1 Paseo browser tab(s).", {
        command: "list_tabs",
        tabs: [
          {
            browserId: BROWSER_ID,
            url: "https://example.com/",
            title: "Example Domain",
            isActive: true,
            isLoading: false,
          },
        ],
      }),
    );

    const listed = await runTabsCommand({ cwd: WORKSPACE_DIR }, NOOP_COMMAND);

    expect(listed.data).toEqual([
      {
        browserId: BROWSER_ID,
        url: "https://example.com/",
        title: "Example Domain",
        isActive: true,
        isLoading: false,
      },
    ]);
  });

  it("surfaces a failed browser tool as a command error carrying the daemon code", async () => {
    stubDaemon({
      content: [{ type: "text", text: "No Paseo browser host is connected." }],
      structuredContent: { ok: false, error: { code: "browser_no_host" } },
    });

    await expect(
      runClickCommand(BROWSER_ID, "@e1", { cwd: WORKSPACE_DIR }, NOOP_COMMAND),
    ).rejects.toMatchObject({
      code: "BROWSER_NO_HOST",
      message: "No Paseo browser host is connected.",
    });
  });
});

describe("browser screenshot --out", () => {
  let outDir: string;

  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), "paseo-browser-cli-"));
  });

  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  it("writes the decoded image bytes to disk", async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    stubDaemon({
      content: [
        { type: "text", text: "Captured browser screenshot (800x600)." },
        { type: "image", data: pngBytes.toString("base64"), mimeType: "image/png" },
      ],
      structuredContent: { ok: true, result: { command: "screenshot", browserId: BROWSER_ID } },
    });
    const outPath = join(outDir, "shot.png");

    const single = await runScreenshotCommand(
      BROWSER_ID,
      { cwd: WORKSPACE_DIR, fullPage: true, out: outPath },
      NOOP_COMMAND,
    );

    expect(await readFile(outPath)).toEqual(pngBytes);
    expect(single.data.summary).toContain(`Saved screenshot to ${outPath}`);
    expect(calls[0]?.input).toEqual({ browserId: BROWSER_ID, fullPage: true });
  });

  it("fails loudly when the daemon returns no image data", async () => {
    stubDaemon(successResult("Captured browser screenshot (800x600).", { command: "screenshot" }));

    await expect(
      runScreenshotCommand(
        BROWSER_ID,
        { cwd: WORKSPACE_DIR, out: join(outDir, "shot.png") },
        NOOP_COMMAND,
      ),
    ).rejects.toMatchObject({ code: "BROWSER_SCREENSHOT_EMPTY" });
  });
});
