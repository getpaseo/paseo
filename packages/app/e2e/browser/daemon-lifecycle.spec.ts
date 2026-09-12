import { randomUUID } from "node:crypto";
import { expect, test } from "../support/fixtures";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import {
  openDaemonOverview,
  restartDaemonInSettings,
  expectDaemonRestartComplete,
  readWorkerPid,
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
