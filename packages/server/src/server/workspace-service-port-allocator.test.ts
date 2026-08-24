import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { allocateWorkspaceServicePort } from "./workspace-service-port-allocator.js";

describe("allocateWorkspaceServicePort", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("allocates an available port within the configured range", async () => {
    const port = await getFreePort();

    await expect(
      allocateWorkspaceServicePort({
        allocation: { range: `${port}-${port}` },
        cwd: tmpdir(),
        scriptName: "web",
        workspaceId: "wks_range_available",
        branchName: "feature/range-available",
      }),
    ).resolves.toBe(port);
  });

  it("fails when every port in the configured range is occupied", async () => {
    const server = net.createServer();
    const port = await listen(server);

    await expect(
      allocateWorkspaceServicePort({
        allocation: { range: `${port}-${port}` },
        cwd: tmpdir(),
        scriptName: "web",
        workspaceId: "wks_range_occupied",
        branchName: "feature/range-occupied",
      }),
    ).rejects.toThrow(`No available service port in configured range ${port}-${port}`);

    await close(server);
  });

  it("passes service and workspace context to portScript", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "workspace-service-port-allocator-"));
    tempDirs.push(tempDir);
    const port = await getFreePort();
    const scriptPath = createContextPortScript(tempDir, port);

    await expect(
      allocateWorkspaceServicePort({
        allocation: { range: "1-1", portScript: scriptPath },
        cwd: tempDir,
        scriptName: "app-server",
        workspaceId: "wks_port_allocator",
        branchName: "feature/allocator-context",
      }),
    ).resolves.toBe(port);
    expect(readFileSync(join(tempDir, "cwd"), "utf8")).toBe(tempDir);
    expect(readFileSync(join(tempDir, "argv"), "utf8")).toBe(
      `app-server|wks_port_allocator|feature/allocator-context|${tempDir}`,
    );
    expect(readFileSync(join(tempDir, "env"), "utf8")).toBe(
      `app-server|wks_port_allocator|feature/allocator-context|${tempDir}`,
    );
  });

  it("accepts a valid portScript result that is already occupied", async () => {
    const server = net.createServer();
    const port = await listen(server);
    const scriptPath = createPortScript(String(port));

    await expect(
      allocateWorkspaceServicePort({
        allocation: { portScript: scriptPath },
        cwd: tmpdir(),
        scriptName: "api",
        workspaceId: "wks_occupied_script_port",
        branchName: null,
      }),
    ).resolves.toBe(port);

    await close(server);
  });

  it("rejects invalid portScript output", async () => {
    const scriptPath = createPortScript("not-a-port");

    await expect(
      allocateWorkspaceServicePort({
        allocation: { portScript: scriptPath },
        cwd: tmpdir(),
        scriptName: "web",
        workspaceId: "wks_invalid_script_output",
        branchName: "feature/invalid-output",
      }),
    ).rejects.toThrow("must print exactly one TCP port");
  });

  function createPortScript(output: string): string {
    const tempDir = mkdtempSync(join(tmpdir(), "workspace-service-port-allocator-"));
    tempDirs.push(tempDir);
    const contents =
      process.platform === "win32"
        ? `@echo off\r\necho ${output}\r\n`
        : `#!/bin/sh\nprintf '%s\\n' '${output}'\n`;
    return writePortScript(tempDir, contents);
  }

  function createContextPortScript(tempDir: string, port: number): string {
    const contents =
      process.platform === "win32"
        ? `@echo off\r\n<nul set /p "=%CD%" > cwd\r\n<nul set /p "=%~1|%~2|%~3|%~4" > argv\r\n<nul set /p "=%PASEO_SCRIPTNAME%|%PASEO_WORKSPACE_ID%|%PASEO_BRANCH_NAME%|%PASEO_WORKTREE_PATH%" > env\r\necho ${port}\r\n`
        : `#!/bin/sh\nprintf '%s' "$PWD" > cwd\nprintf '%s|%s|%s|%s' "$1" "$2" "$3" "$4" > argv\nprintf '%s|%s|%s|%s' "$PASEO_SCRIPTNAME" "$PASEO_WORKSPACE_ID" "$PASEO_BRANCH_NAME" "$PASEO_WORKTREE_PATH" > env\nprintf '${port}\\n'\n`;
    return writePortScript(tempDir, contents);
  }

  function writePortScript(tempDir: string, contents: string): string {
    const fileName = process.platform === "win32" ? "portmake.cmd" : "portmake";
    const scriptPath = join(tempDir, fileName);
    writeFileSync(scriptPath, contents);
    if (process.platform !== "win32") chmodSync(scriptPath, 0o755);
    return scriptPath;
  }
});

function getFreePort(): Promise<number> {
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Expected TCP server address"));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
    server.on("error", reject);
  });
}

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected TCP server address");
      }
      resolve(address.port);
    });
  });
}

function close(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
