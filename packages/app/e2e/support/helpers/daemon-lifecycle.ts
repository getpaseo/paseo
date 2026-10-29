import { execFile, spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, type Page } from "@playwright/test";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { connectDaemonClient } from "./daemon-client-loader";
import { openSettings } from "./app";
import { openHostSection, openSettingsHost, seedSavedSettingsHosts } from "./settings";
import type { IsolatedHostDaemon } from "./isolated-host-daemon";

export async function openDaemonOverview(page: Page, daemon: IsolatedHostDaemon) {
  await seedSavedSettingsHosts(page, [
    { serverId: daemon.serverId, label: "Lifecycle host", endpoint: `127.0.0.1:${daemon.port}` },
  ]);
  await page.reload();
  await openSettings(page);
  await openSettingsHost(page, daemon.serverId);
  await openHostSection(page, daemon.serverId, "host");
}

export async function restartDaemonInSettings(
  page: Page,
  options: { closeTerminals?: boolean } = {},
) {
  const button = page.getByRole("button", {
    name: options.closeTerminals ? "Restart and close terminals" : "Restart",
    exact: true,
  });
  await expect(button).toBeEnabled();
  page.once("dialog", (dialog) => dialog.accept());
  await button.click();
  await expect(page.getByRole("button", { name: "Restarting...", exact: true })).toBeDisabled();
}

export async function expectDaemonRestartFailed(page: Page, text: string) {
  const error = page.getByTestId("host-page-restart-error");
  await expect(error).toBeVisible({ timeout: 30_000 });
  await expect(error).toContainText(text);
  await expect(page.getByRole("button", { name: "Restart", exact: true })).toBeEnabled();
}

export async function expectDaemonRestartComplete(page: Page) {
  await expect(page.getByRole("button", { name: "Restart", exact: true })).toBeEnabled({
    timeout: 30_000,
  });
}

export async function readWorkerPid(daemon: IsolatedHostDaemon): Promise<number> {
  const client = await connectDaemonClient<DaemonClient>({
    port: daemon.port,
    clientIdPrefix: "lifecycle-observer",
  });
  try {
    return (await client.getDaemonStatus()).pid;
  } finally {
    await client.close();
  }
}

/** Opens a terminal on the isolated daemon that runs a long-lived program. */
export async function openLongLivedTerminal(daemon: IsolatedHostDaemon): Promise<string> {
  const client = await connectDaemonClient<DaemonClient>({
    port: daemon.port,
    clientIdPrefix: "lifecycle-terminal",
  });
  try {
    const workspace = await client.createWorkspace({
      source: { kind: "directory", path: daemon.paseoHome },
      title: "lifecycle",
    });
    if (!workspace.workspace) throw new Error(workspace.error ?? "Workspace creation failed");
    const created = await client.createTerminal(daemon.paseoHome, "lifecycle", undefined, {
      workspaceId: workspace.workspace.id,
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1e9)"],
    });
    if (!created.terminal) throw new Error(created.error ?? "Terminal creation failed");
    return created.terminal.id;
  } finally {
    await client.close();
  }
}

export async function listTerminalIds(daemon: IsolatedHostDaemon): Promise<string[]> {
  const client = await connectDaemonClient<DaemonClient>({
    port: daemon.port,
    clientIdPrefix: "lifecycle-terminals",
  });
  try {
    return (await client.listTerminals()).terminals.map((terminal) => terminal.id);
  } finally {
    await client.close();
  }
}

const execFileAsync = promisify(execFile);

async function psField(pid: number, field: "stat" | "lstart"): Promise<string> {
  const { stdout } = await execFileAsync("ps", ["-o", `${field}=`, "-p", String(pid)], {
    env: { ...process.env, LC_ALL: "C" },
  });
  return stdout.trim();
}

export interface UnclosableTerminalProgram {
  pid: number;
  /** Ends the program's parent, which lets the system reap the program. */
  release(): void;
}

/**
 * Leaves in the daemon's home the record a dead terminal worker leaves, naming one terminal
 * program that SIGKILL cannot remove: a zombie whose parent (an exec'd `sleep`) never waits for
 * it. A kill cleanup can only report it as still running. POSIX only.
 */
export async function plantUnclosableTerminalProgram(
  daemon: IsolatedHostDaemon,
): Promise<UnclosableTerminalProgram> {
  const parent = spawn("/bin/sh", ["-c", "sleep 0 & echo $!; exec sleep 600"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  parent.unref();
  const release = () => {
    if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
  };
  try {
    const pid = await new Promise<number>((resolve) => {
      parent.stdout!.once("data", (chunk: Buffer) => resolve(Number(chunk.toString().trim())));
    });
    await expect.poll(async () => (await psField(pid, "stat")).startsWith("Z")).toBe(true);
    const gone = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await new Promise((resolve) => gone.once("exit", resolve));
    const record = {
      recordId: "planted-record",
      pid: gone.pid,
      bootId: null,
      createdAt: new Date().toISOString(),
      identity: { startedAt: "Thu Jan  1 00:00:00 1970", commandLine: "planted-worker" },
      protocolVersion: 1,
      paseoVersion: "0.0.0-test",
      socketPath: path.join(daemon.paseoHome, "planted-worker.sock"),
      secret: "planted-secret",
      terminals: [{ id: "planted-terminal", pid, startedAt: await psField(pid, "lstart") }],
    };
    await writeFile(
      path.join(daemon.paseoHome, "terminal-worker", `${gone.pid}.json`),
      `${JSON.stringify(record, null, 2)}\n`,
      { mode: 0o600 },
    );
    return { pid, release };
  } catch (error) {
    release();
    throw error;
  }
}
