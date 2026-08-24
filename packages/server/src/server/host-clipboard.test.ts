import { existsSync, readFileSync, unlinkSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";

import * as spawnUtils from "../utils/spawn.js";
import {
  materializeClipboardImageToTempFile,
  writeImageToHostClipboard,
  writeImageToHostClipboardOnPlatform,
} from "./host-clipboard.js";

const PNG_BYTES = Buffer.from("89504e470d0a1a0a", "hex");
const PNG_PAYLOAD = PNG_BYTES.toString("base64");

interface ChildStubOptions {
  exitCode?: number | null;
  stderr?: string;
  spawnError?: Error;
}

/**
 * A child modelling the real Linux tools: wl-copy and xclip fork a selection
 * owner that inherits our stdout/stderr pipes, so the streams never close on
 * their own and the child only ever reports "exit".
 */
function createChildStub(options: ChildStubOptions = {}): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = (() => true) as ChildProcess["kill"];
  if (options.spawnError) {
    queueMicrotask(() => {
      child.emit("error", options.spawnError);
    });
    return child;
  }
  queueMicrotask(() => {
    if (options.stderr) {
      child.stderr?.write(options.stderr);
    }
    child.emit("exit", options.exitCode ?? 0, null);
  });
  return child;
}

interface RecordedCommand {
  command: string;
  args: string[];
}

/**
 * Records every exec invocation; stubs `which` lookups against `available`,
 * while any other command reports success.
 */
function recordExecCommands(available: Record<string, boolean>): RecordedCommand[] {
  const calls: RecordedCommand[] = [];
  vi.spyOn(spawnUtils, "execCommand").mockImplementation(async (command, args) => {
    calls.push({ command, args });
    if (command === "which") {
      const target = args[0] ?? "";
      if (!available[target]) {
        throw new Error(`which: no ${target} in (PATH)`);
      }
      return { stdout: `/usr/bin/${target}`, stderr: "" };
    }
    return { stdout: "", stderr: "" };
  });
  return calls;
}

interface RecordedSpawn extends RecordedCommand {
  options: { shell?: boolean; stdio?: unknown };
}

/** Spawns a stub child for every invocation, recording command lines. */
function recordSpawns(childOptions: ChildStubOptions = {}): RecordedSpawn[] {
  const calls: RecordedSpawn[] = [];
  vi.spyOn(spawnUtils, "spawnProcess").mockImplementation((command, args, spawnOptions) => {
    calls.push({
      command,
      args,
      options: (spawnOptions ?? {}) as RecordedSpawn["options"],
    });
    return createChildStub(childOptions);
  });
  return calls;
}

function extractTempPathFromOsascript(script: string): string {
  const match = /POSIX file "([^"]+)"/.exec(script);
  expect(match).toBeTruthy();
  return match![1];
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("host clipboard platform dispatch", () => {
  describe("darwin", () => {
    test("writes a png through osascript and cleans up the temp file", async () => {
      recordExecCommands({});
      const spawns = recordSpawns();

      const result = await writeImageToHostClipboardOnPlatform({
        platform: "darwin",
        mimeType: "image/png",
        dataBase64: PNG_PAYLOAD,
      });

      expect(result).toEqual({ success: true, error: null });
      expect(spawns).toHaveLength(1);
      expect(spawns[0]?.command).toBe("osascript");
      expect(spawns[0]?.args[0]).toBe("-e");
      const script = spawns[0]?.args[1] ?? "";
      expect(script).toContain("«class PNGf»");
      const tempPath = extractTempPathFromOsascript(script);
      expect(tempPath.startsWith(join(tmpdir(), "paseo-clipboard-"))).toBe(true);
      expect(existsSync(tempPath)).toBe(false);
    });

    test("maps jpeg to the JPEG picture clipboard flavor", async () => {
      recordExecCommands({});
      const spawns = recordSpawns();

      const result = await writeImageToHostClipboardOnPlatform({
        platform: "darwin",
        mimeType: "image/jpeg",
        dataBase64: PNG_PAYLOAD,
      });

      expect(result.success).toBe(true);
      const script = spawns[0]?.args[1] ?? "";
      expect(script).toContain("«class JPEG picture»");
    });

    test("surfaces tool failures without throwing", async () => {
      recordExecCommands({});
      recordSpawns({ exitCode: 1, stderr: "osascript: clipboards are busy" });

      const result = await writeImageToHostClipboardOnPlatform({
        platform: "darwin",
        mimeType: "image/png",
        dataBase64: PNG_PAYLOAD,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("osascript failed: osascript: clipboards are busy");
    });

    test("surfaces spawn errors without throwing", async () => {
      recordExecCommands({});
      recordSpawns({ spawnError: new Error("spawn osascript ENOENT") });

      const result = await writeImageToHostClipboardOnPlatform({
        platform: "darwin",
        mimeType: "image/png",
        dataBase64: PNG_PAYLOAD,
      });

      expect(result).toEqual({
        success: false,
        error: "osascript failed: spawn osascript ENOENT",
      });
    });
  });

  describe("linux", () => {
    test("prefers xclip with the selection argv when no Wayland display is set", async () => {
      recordExecCommands({ xclip: true });
      const spawns = recordSpawns();

      const result = await writeImageToHostClipboardOnPlatform({
        platform: "linux",
        mimeType: "image/png",
        dataBase64: PNG_PAYLOAD,
      });

      expect(result).toEqual({ success: true, error: null });
      expect(spawns).toHaveLength(1);
      expect(spawns[0]?.command).toBe("xclip");
      expect(spawns[0]?.args).toEqual([
        "-selection",
        "clipboard",
        "-t",
        "image/png",
        "-i",
        expect.stringMatching(/paseo-clipboard-/),
      ]);
      expect(spawns[0]?.options.stdio?.[0]).toBe("ignore");
    });

    test("pipes the image into wl-copy over an inherited stdin fd on Wayland", async () => {
      recordExecCommands({ "wl-copy": true });
      const spawns = recordSpawns();

      const result = await writeImageToHostClipboardOnPlatform({
        platform: "linux",
        mimeType: "image/jpeg",
        dataBase64: PNG_PAYLOAD,
        env: { WAYLAND_DISPLAY: "wayland-0" },
      });

      expect(result).toEqual({ success: true, error: null });
      expect(spawns).toHaveLength(1);
      expect(spawns[0]?.command).toBe("wl-copy");
      expect(spawns[0]?.args).toEqual(["-t", "image/jpeg"]);
      // The temp file is handed to the child as its stdin, not as an argument.
      expect(spawns[0]?.options.stdio?.[0]).toEqual(expect.any(Number));
    });

    test("falls back to xclip when wl-copy is missing on a Wayland session", async () => {
      const _execCalls = recordExecCommands({ xclip: true });
      const spawns = recordSpawns();

      const result = await writeImageToHostClipboardOnPlatform({
        platform: "linux",
        mimeType: "image/png",
        dataBase64: PNG_PAYLOAD,
        env: { WAYLAND_DISPLAY: "wayland-0" },
      });

      expect(result.success).toBe(true);
      expect(spawns).toHaveLength(1);
      expect(spawns[0]?.command).toBe("xclip");
    });

    test("returns an actionable error when no clipboard tool exists", async () => {
      recordExecCommands({});
      const spawns = recordSpawns();

      const result = await writeImageToHostClipboardOnPlatform({
        platform: "linux",
        mimeType: "image/png",
        dataBase64: PNG_PAYLOAD,
        env: { WAYLAND_DISPLAY: "wayland-0" },
      });

      expect(result).toEqual({
        success: false,
        error: "no clipboard tool available on the host; install wl-clipboard (wl-copy) or xclip",
      });
      expect(spawns).toEqual([]);
    });

    test("reports a tool that exits nonzero instead of throwing", async () => {
      recordExecCommands({ "wl-copy": true });
      recordSpawns({ exitCode: 1, stderr: "No compositor on display" });

      const result = await writeImageToHostClipboardOnPlatform({
        platform: "linux",
        mimeType: "image/png",
        dataBase64: PNG_PAYLOAD,
        env: { WAYLAND_DISPLAY: "wayland-0" },
      });

      expect(result).toEqual({
        success: false,
        error: "wl-copy failed: No compositor on display",
      });
    });
  });

  describe("win32", () => {
    test("invokes Set-Clipboard with the quoted temp file path", async () => {
      recordExecCommands({});
      const spawns = recordSpawns();

      const result = await writeImageToHostClipboardOnPlatform({
        platform: "win32",
        mimeType: "image/jpeg",
        dataBase64: PNG_PAYLOAD,
      });

      expect(result).toEqual({ success: true, error: null });
      expect(spawns).toHaveLength(1);
      expect(spawns[0]?.command).toBe("powershell");
      expect(spawns[0]?.args).toEqual([
        "-NoProfile",
        "-Command",
        expect.stringMatching(/^Set-Clipboard -Path '.+\.jpg'$/),
      ]);
    });
  });

  describe("payload guards", () => {
    test("rejects unsupported platforms before touching the OS", async () => {
      const execCalls = recordExecCommands({});
      const spawns = recordSpawns();

      const result = await writeImageToHostClipboardOnPlatform({
        platform: "freebsd",
        mimeType: "image/png",
        dataBase64: PNG_PAYLOAD,
      });

      expect(result).toEqual({
        success: false,
        error: "clipboard write unsupported on this platform",
      });
      expect(execCalls).toEqual([]);
      expect(spawns).toEqual([]);
    });

    test("rejects payloads above the decoded size limit without spawning anything", async () => {
      const execCalls = recordExecCommands({});
      const spawns = recordSpawns();
      const oversized = Buffer.alloc(10 * 1024 * 1024 + 1).toString("base64");

      const result = await writeImageToHostClipboardOnPlatform({
        platform: "darwin",
        mimeType: "image/png",
        dataBase64: oversized,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("10 MiB");
      expect(execCalls).toEqual([]);
      expect(spawns).toEqual([]);
    });

    test("accepts payloads at exactly the size limit", async () => {
      recordExecCommands({});
      const spawns = recordSpawns();
      const atLimit = Buffer.alloc(10 * 1024 * 1024).toString("base64");

      const result = await writeImageToHostClipboardOnPlatform({
        platform: "darwin",
        mimeType: "image/png",
        dataBase64: atLimit,
      });

      expect(result.success).toBe(true);
      expect(spawns[0]?.command).toBe("osascript");
    });

    test("rejects empty payloads", async () => {
      const execCalls = recordExecCommands({});
      const spawns = recordSpawns();

      const result = await writeImageToHostClipboardOnPlatform({
        platform: "darwin",
        mimeType: "image/png",
        dataBase64: "",
      });

      expect(result).toEqual({ success: false, error: "clipboard image payload is empty" });
      expect(execCalls).toEqual([]);
      expect(spawns).toEqual([]);
    });
  });

  test("public entry point dispatches the running platform", async () => {
    recordExecCommands({ xclip: true });
    const spawns = recordSpawns();

    const result = await writeImageToHostClipboard({
      mimeType: "image/png",
      dataBase64: PNG_PAYLOAD,
    });

    expect(result).toEqual({ success: true, error: null });
    let expectedCommand = "xclip";
    if (process.platform === "win32") {
      expectedCommand = "powershell";
    } else if (process.platform === "darwin") {
      expectedCommand = "osascript";
    }
    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.command).toBe(expectedCommand);
  });
});

describe("materializeClipboardImageToTempFile", () => {
  test("writes a readable png file with the right bytes and leaves it in place", async () => {
    const result = await materializeClipboardImageToTempFile({
      mimeType: "image/png",
      dataBase64: PNG_PAYLOAD,
    });

    try {
      expect(basename(result.path)).toMatch(/^paseo-image-paste-\d+-\d+\.png$/);
      expect(join(tmpdir(), basename(result.path))).toBe(result.path);
      expect(existsSync(result.path)).toBe(true);
      expect(readFileSync(result.path).equals(PNG_BYTES)).toBe(true);
    } finally {
      unlinkSync(result.path);
    }
  });

  test("uses a .jpg extension for jpegs", async () => {
    const result = await materializeClipboardImageToTempFile({
      mimeType: "image/jpeg",
      dataBase64: PNG_PAYLOAD,
    });

    try {
      expect(result.path.endsWith(".jpg")).toBe(true);
    } finally {
      unlinkSync(result.path);
    }
  });

  test("rejects oversized payloads without writing a file", async () => {
    const oversized = Buffer.alloc(10 * 1024 * 1024 + 1).toString("base64");

    await expect(
      materializeClipboardImageToTempFile({
        mimeType: "image/png",
        dataBase64: oversized,
      }),
    ).rejects.toThrow("10 MiB");
    // The failed call wrote nothing; the next successful call still produces
    // a well-formed name.
    const result = await materializeClipboardImageToTempFile({
      mimeType: "image/png",
      dataBase64: PNG_PAYLOAD,
    });
    try {
      expect(basename(result.path)).toMatch(/^paseo-image-paste-\d+-\d+\.png$/);
    } finally {
      unlinkSync(result.path);
    }
  });
});
