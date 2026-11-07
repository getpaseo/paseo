import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, daemonTest as cleanupTest } from "../support/fixtures";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import {
  openDaemonOverview,
  restartDaemonInSettings,
  expectDaemonRestartComplete,
  expectDaemonRestartFailed,
  plantUnclosableTerminalProgram,
  readWorkerPid,
  openLongLivedTerminal,
  listTerminalIds,
  suspendDaemonProcess,
  resumeDaemonProcess,
  daemonProcessCanWrite,
  readTerminalProcessIds,
} from "../support/helpers/daemon-lifecycle";

test("settings restart waits for a replacement worker while retaining the supervisor", async ({
  page,
}, testInfo) => {
  const daemon = await startIsolatedHostDaemon(randomUUID());
  try {
    const supervisor = daemon.getPid();
    const previousWorker = await readWorkerPid(daemon);
    await openDaemonOverview(page, daemon);
    await restartDaemonInSettings(page);
    await expectDaemonRestartComplete(page);
    expect(await readWorkerPid(daemon)).not.toBe(previousWorker);
    expect(daemon.getPid()).toBe(supervisor);
    await page.screenshot({ path: testInfo.outputPath("restart-confirmed.png"), fullPage: true });
  } finally {
    await daemon.close();
  }
});

test("settings restart keeps a terminal", async ({ page }) => {
  const daemon = await startIsolatedHostDaemon(randomUUID());
  try {
    const terminalId = await openLongLivedTerminal(daemon);
    const previousWorker = await readWorkerPid(daemon);
    await openDaemonOverview(page, daemon);
    await restartDaemonInSettings(page);
    await expectDaemonRestartComplete(page);
    expect(await readWorkerPid(daemon)).not.toBe(previousWorker);
    expect(await listTerminalIds(daemon)).toContain(terminalId);
  } finally {
    await daemon.close();
  }
});

test("settings restart and close terminals closes the terminal", async ({ page }) => {
  const daemon = await startIsolatedHostDaemon(randomUUID());
  try {
    await openLongLivedTerminal(daemon);
    const previousWorker = await readWorkerPid(daemon);
    await openDaemonOverview(page, daemon);
    await restartDaemonInSettings(page, { closeTerminals: true });
    await expectDaemonRestartComplete(page);
    expect(await readWorkerPid(daemon)).not.toBe(previousWorker);
    expect(await listTerminalIds(daemon)).toEqual([]);
  } finally {
    await daemon.close();
  }
});

test("settings restart and close terminals shows the processes it could not close", async ({
  page,
}, testInfo) => {
  test.skip(process.platform === "win32", "The unclosable program is a POSIX zombie");
  const daemon = await startIsolatedHostDaemon(randomUUID());
  let program: Awaited<ReturnType<typeof plantUnclosableTerminalProgram>> | null = null;
  try {
    program = await plantUnclosableTerminalProgram(daemon);
    await openDaemonOverview(page, daemon);
    await restartDaemonInSettings(page, { closeTerminals: true });
    await expectDaemonRestartFailed(page, `pid ${program.pid}`);
    await page.screenshot({
      path: testInfo.outputPath("restart-cleanup-failed.png"),
      fullPage: true,
    });
  } finally {
    program?.release();
    await daemon.close();
  }
});

test("settings restart replaces the worker when a provider CLI answers --version slowly", async ({
  page,
}) => {
  test.skip(process.platform === "win32", "The slow provider stub is a POSIX script");
  const daemon = await startIsolatedHostDaemon(randomUUID(), {
    paseoHome: await createHomeWithSlowProvider(1_800),
  });
  try {
    const previousWorker = await readWorkerPid(daemon);
    await openDaemonOverview(page, daemon);
    await restartDaemonInSettings(page);
    await expectDaemonRestartComplete(page);
    expect(await readWorkerPid(daemon)).not.toBe(previousWorker);
  } finally {
    await daemon.close();
  }
});

async function createHomeWithSlowProvider(versionDelayMs: number): Promise<string> {
  const paseoHome = await mkdtemp(path.join(tmpdir(), "paseo-e2e-slow-provider-"));
  const provider = path.join(paseoHome, "slow-provider");
  await writeFile(
    provider,
    `#!${process.execPath}\nsetTimeout(() => console.log("provider 1.0.0"), ${versionDelayMs});\n`,
    { mode: 0o700 },
  );
  await writeFile(
    path.join(paseoHome, "config.json"),
    `${JSON.stringify({
      version: 1,
      agents: { providers: { claude: { command: { mode: "replace", argv: [provider] } } } },
    })}\n`,
  );
  return paseoHome;
}

// Cleanup has no renderer demand: drive the same isolated daemon owner directly.
// A stopped worker deterministically outlives the old helper's five-second
// supervisor-only kill and logs into its deleted home when resumed.
cleanupTest(
  "isolated cleanup prevents a stopped worker from recreating its deleted home",
  async () => {
    cleanupTest.skip(process.platform === "win32", "POSIX stopped-process failure injection");
    const daemon = await startIsolatedHostDaemon(randomUUID());
    const workerPid = await readWorkerPid(daemon);
    try {
      suspendDaemonProcess(workerPid);
      await daemon.close();
      resumeDaemonProcess(workerPid);
      await expect.poll(() => daemonProcessCanWrite(workerPid)).toBe(false);
      expect(existsSync(daemon.paseoHome)).toBe(false);
    } finally {
      resumeDaemonProcess(workerPid);
      await daemon.close();
      await rm(daemon.paseoHome, { recursive: true, force: true });
    }
  },
);

cleanupTest(
  "isolated cleanup force-stops a frozen supervisor and its detached terminal writers",
  async () => {
    cleanupTest.skip(process.platform === "win32", "POSIX stopped-process failure injection");
    const daemon = await startIsolatedHostDaemon(randomUUID());
    const supervisorPid = daemon.getPid()!;
    const workerPid = await readWorkerPid(daemon);
    try {
      await openLongLivedTerminal(daemon);
      const terminalProcesses = await readTerminalProcessIds(daemon);
      expect(terminalProcesses.length).toBeGreaterThanOrEqual(2);
      suspendDaemonProcess(supervisorPid);
      await daemon.close();
      const writerStates = await Promise.all(
        [supervisorPid, workerPid, ...terminalProcesses].map(daemonProcessCanWrite),
      );
      expect(writerStates).toEqual(Array(terminalProcesses.length + 2).fill(false));
      expect(existsSync(daemon.paseoHome)).toBe(false);
    } finally {
      resumeDaemonProcess(supervisorPid);
      await daemon.close();
    }
  },
);
