import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
