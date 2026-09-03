import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createExternalProcessEnv,
  execCommand,
  quoteWindowsArgument,
  shouldUseWindowsShell,
} from "./server/process";

describe("Codeup process execution", () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
  });

  it("routes extensionless PATH commands through the Windows shell", () => {
    Object.defineProperty(process, "platform", { value: "win32", writable: true });

    expect(shouldUseWindowsShell("aliyun")).toBe(true);
    expect(shouldUseWindowsShell("C:\\tools\\aliyun.cmd")).toBe(true);
    expect(shouldUseWindowsShell("C:\\tools\\aliyun.exe")).toBe(false);
  });

  it("escapes JSON arguments before cmd.exe interprets user-authored MR text", () => {
    Object.defineProperty(process, "platform", { value: "win32", writable: true });

    const argument = quoteWindowsArgument(
      JSON.stringify({ title: "Ship & test | deploy ^ now < later > (safe) !" }),
    );
    expect(argument).toContain("^&");
    expect(argument).toContain("^|");
    expect(argument).toContain("^^");
    expect(argument).toContain("^<");
    expect(argument).toContain("^>");
    expect(argument).toContain("^(");
    expect(argument).toContain("^)");
    expect(argument).toContain("^!");
  });

  it("escapes percent expansion twice for Windows command scripts", () => {
    Object.defineProperty(process, "platform", { value: "win32", writable: true });

    const argument = quoteWindowsArgument("%PASEO_TEST_SECRET%", true);
    expect(argument).not.toContain("%PASEO_TEST_SECRET%");
    expect(argument).toContain("^^^%");
  });

  it("removes Paseo runtime controls from external command environments", () => {
    expect(
      createExternalProcessEnv(
        {
          PATH: "/bin",
          CUSTOM: "base",
          PASEO_NODE_ENV: "development",
          PASEO_SUPERVISED: "1",
          ELECTRON_RUN_AS_NODE: "1",
          ESBUILD_BINARY_PATH: "/tmp/esbuild",
          REMOVE_ME: "set",
        },
        {
          CUSTOM: "overlay",
          PASEO_DESKTOP_MANAGED: "1",
          REMOVE_ME: undefined,
        },
      ),
    ).toEqual({ PATH: "/bin", CUSTOM: "overlay" });
  });
});

describe.skipIf(process.platform !== "win32")("Codeup Windows command scripts", () => {
  it("passes percent-delimited text literally instead of expanding daemon environment values", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-codeup-cmd-"));
    try {
      const captureScript = path.join(directory, "capture.cjs");
      const commandScript = path.join(directory, "capture.cmd");
      await writeFile(
        captureScript,
        "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n",
        "utf8",
      );
      await writeFile(
        commandScript,
        `@echo off\r\n"${process.execPath}" "%~dp0capture.cjs" %*\r\n`,
        "utf8",
      );

      const result = await execCommand(commandScript, ["%PASEO_TEST_SECRET%"], {
        cwd: directory,
        envOverlay: { PASEO_TEST_SECRET: "expanded-secret" },
      });

      expect(JSON.parse(result.stdout)).toEqual(["%PASEO_TEST_SECRET%"]);
      expect(result.stdout).not.toContain("expanded-secret");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
