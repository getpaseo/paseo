import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  AUTOMATIC_CHECK_INTERVAL_MS,
  UPDATE_COOLDOWN_MS,
  createAppUpdatePacing,
} from "./app-update-pacing";

const HOUR_MS = 3_600_000;
const START = Date.parse("2026-04-28T12:00:00.000Z");

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function createUserData(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "paseo-update-pacing-"));
  tempDirs.push(dir);
  return dir;
}

interface Install {
  filePath: string;
  errors: unknown[];
  advance(ms: number): void;
  setClock(time: number): void;
  /** Starts the app again, as a new process would, on the given version. */
  launch(version: string): ReturnType<typeof createAppUpdatePacing>;
  readFile(): Promise<unknown>;
}

async function createInstall(input?: { filePath?: string }): Promise<Install> {
  const filePath = input?.filePath ?? path.join(await createUserData(), "app-update-pacing.json");
  const errors: unknown[] = [];
  let now = START;
  return {
    filePath,
    errors,
    advance(ms) {
      now += ms;
    },
    setClock(time) {
      now = time;
    },
    launch(version) {
      return createAppUpdatePacing({
        filePath: () => filePath,
        currentVersion: () => version,
        now: () => now,
        reportError: (error) => errors.push(error),
      });
    },
    async readFile() {
      return JSON.parse(await readFile(filePath, "utf8"));
    },
  };
}

describe("automatic check interval", () => {
  it("is due on a fresh install", async () => {
    const install = await createInstall();
    const pacing = install.launch("1.2.3");

    expect(await pacing.isAutomaticCheckDue()).toBe(true);
  });

  it("is not due again until 6 hours after a recorded check", async () => {
    const install = await createInstall();
    const pacing = install.launch("1.2.3");

    await pacing.recordAutomaticCheck();
    expect(await pacing.isAutomaticCheckDue()).toBe(false);

    install.advance(AUTOMATIC_CHECK_INTERVAL_MS - 1);
    expect(await pacing.isAutomaticCheckDue()).toBe(false);

    install.advance(1);
    expect(await pacing.isAutomaticCheckDue()).toBe(true);
  });

  it("stays due until a check is recorded, so a failed check is retried", async () => {
    const install = await createInstall();
    const pacing = install.launch("1.2.3");

    expect(await pacing.isAutomaticCheckDue()).toBe(true);
    install.advance(HOUR_MS);
    expect(await pacing.isAutomaticCheckDue()).toBe(true);
  });

  it("remembers the last check across restarts", async () => {
    const install = await createInstall();
    await install.launch("1.2.3").recordAutomaticCheck();

    install.advance(HOUR_MS);
    expect(await install.launch("1.2.3").isAutomaticCheckDue()).toBe(false);

    install.advance(AUTOMATIC_CHECK_INTERVAL_MS);
    expect(await install.launch("1.2.3").isAutomaticCheckDue()).toBe(true);
  });

  it("is due when the last check is in the future because the clock moved back", async () => {
    const install = await createInstall();
    install.setClock(START + 365 * 24 * HOUR_MS);
    await install.launch("1.2.3").recordAutomaticCheck();

    install.setClock(START);
    const pacing = install.launch("1.2.3");
    expect(await pacing.isAutomaticCheckDue()).toBe(true);

    await pacing.recordAutomaticCheck();
    expect(await install.readFile()).toMatchObject({ lastAutoCheckAt: START });
  });

  it("is due after the clock jumps forward", async () => {
    const install = await createInstall();
    const pacing = install.launch("1.2.3");
    await pacing.recordAutomaticCheck();

    install.setClock(START + 365 * 24 * HOUR_MS);
    expect(await pacing.isAutomaticCheckDue()).toBe(true);
  });
});

describe("update cooldown", () => {
  it("does not start on a fresh install", async () => {
    const install = await createInstall();
    const pacing = install.launch("1.2.3");

    expect(await pacing.isInUpdateCooldown()).toBe(false);
    expect(await install.readFile()).toEqual({
      lastAutoCheckAt: null,
      lastVersionSeen: "1.2.3",
      lastAutoUpdateAt: null,
    });
  });

  it("does not start when the app upgrades from a build that kept no pacing state", async () => {
    const install = await createInstall();
    // The earlier build never wrote the file, so there is no version to compare with.
    const pacing = install.launch("1.2.4");

    expect(await pacing.isInUpdateCooldown()).toBe(false);
    expect(await install.readFile()).toMatchObject({
      lastVersionSeen: "1.2.4",
      lastAutoUpdateAt: null,
    });
  });

  it("starts when the app launches on a newer version and lasts 72 hours", async () => {
    const install = await createInstall();
    await install.launch("1.2.3").start();

    install.advance(HOUR_MS);
    const pacing = install.launch("1.2.4");
    expect(await pacing.isInUpdateCooldown()).toBe(true);
    expect(await install.readFile()).toMatchObject({
      lastVersionSeen: "1.2.4",
      lastAutoUpdateAt: START + HOUR_MS,
    });

    install.advance(UPDATE_COOLDOWN_MS - 1);
    expect(await pacing.isInUpdateCooldown()).toBe(true);

    install.advance(1);
    expect(await pacing.isInUpdateCooldown()).toBe(false);
  });

  it("starts when a prerelease build is replaced by its release", async () => {
    const install = await createInstall();
    await install.launch("1.3.0-beta.2").start();

    expect(await install.launch("1.3.0").isInUpdateCooldown()).toBe(true);
  });

  it("is not restarted by launching the same version again", async () => {
    const install = await createInstall();
    await install.launch("1.2.3").start();
    await install.launch("1.2.4").start();

    install.advance(UPDATE_COOLDOWN_MS - HOUR_MS);
    expect(await install.launch("1.2.4").isInUpdateCooldown()).toBe(true);

    install.advance(HOUR_MS);
    expect(await install.launch("1.2.4").isInUpdateCooldown()).toBe(false);
    expect(await install.readFile()).toMatchObject({ lastAutoUpdateAt: START });
  });

  it("is not started by a downgrade, and a downgrade keeps a running cooldown", async () => {
    const install = await createInstall();
    await install.launch("1.2.4").start();

    install.advance(HOUR_MS);
    expect(await install.launch("1.2.3").isInUpdateCooldown()).toBe(false);
    expect(await install.readFile()).toMatchObject({
      lastVersionSeen: "1.2.4",
      lastAutoUpdateAt: null,
    });

    install.advance(HOUR_MS);
    await install.launch("1.2.5").start();
    install.advance(HOUR_MS);
    expect(await install.launch("1.2.4").isInUpdateCooldown()).toBe(true);
    expect(await install.readFile()).toMatchObject({
      lastVersionSeen: "1.2.5",
      lastAutoUpdateAt: START + 2 * HOUR_MS,
    });
  });

  it("is not restarted by switching between two installed builds", async () => {
    const install = await createInstall();
    await install.launch("1.2.3").start();
    await install.launch("1.2.4").start();

    install.advance(UPDATE_COOLDOWN_MS);
    for (let round = 0; round < 3; round += 1) {
      expect(await install.launch("1.2.3").isInUpdateCooldown()).toBe(false);
      expect(await install.launch("1.2.4").isInUpdateCooldown()).toBe(false);
    }
    expect(await install.readFile()).toMatchObject({
      lastVersionSeen: "1.2.4",
      lastAutoUpdateAt: START,
    });
  });

  it("is not started when the stored version cannot be compared", async () => {
    const install = await createInstall();
    await writeFile(
      install.filePath,
      JSON.stringify({ lastAutoCheckAt: null, lastVersionSeen: "nightly", lastAutoUpdateAt: null }),
    );

    expect(await install.launch("1.2.4").isInUpdateCooldown()).toBe(false);
    expect(await install.readFile()).toMatchObject({ lastVersionSeen: "1.2.4" });
  });

  it("is over when the recorded update is in the future because the clock moved back", async () => {
    const install = await createInstall();
    await install.launch("1.2.3").start();
    install.setClock(START + 365 * 24 * HOUR_MS);
    await install.launch("1.2.4").start();

    install.setClock(START);
    expect(await install.launch("1.2.4").isInUpdateCooldown()).toBe(false);
  });

  it("is over after the clock jumps forward", async () => {
    const install = await createInstall();
    await install.launch("1.2.3").start();
    const pacing = install.launch("1.2.4");
    expect(await pacing.isInUpdateCooldown()).toBe(true);

    install.setClock(START + 365 * 24 * HOUR_MS);
    expect(await pacing.isInUpdateCooldown()).toBe(false);
  });

  it("is measured from launch, even when nothing asks until later", async () => {
    const install = await createInstall();
    await install.launch("1.2.3").start();
    const pacing = install.launch("1.2.4");
    await pacing.start();

    install.advance(UPDATE_COOLDOWN_MS);
    expect(await pacing.isInUpdateCooldown()).toBe(false);
  });
});

describe("damaged pacing state", () => {
  const damagedFiles: Array<[string, string]> = [
    ["an empty file", ""],
    ["truncated JSON", '{"lastAutoCheckAt": 17773'],
    ["binary garbage", "\u0000\u0001�\u0000"],
    ["a JSON array", "[1, 2, 3]"],
    ["JSON null", "null"],
    ["a JSON number", "42"],
    ["a JSON string", '"hello"'],
  ];

  for (const [name, contents] of damagedFiles) {
    it(`treats ${name} as a fresh install and replaces it`, async () => {
      const install = await createInstall();
      await writeFile(install.filePath, contents);
      const pacing = install.launch("1.2.3");

      expect(await pacing.isAutomaticCheckDue()).toBe(true);
      expect(await pacing.isInUpdateCooldown()).toBe(false);
      expect(await install.readFile()).toEqual({
        lastAutoCheckAt: null,
        lastVersionSeen: "1.2.3",
        lastAutoUpdateAt: null,
      });
    });
  }

  it("drops each field that has the wrong shape", async () => {
    const install = await createInstall();
    await writeFile(
      install.filePath,
      JSON.stringify({
        lastAutoCheckAt: "yesterday",
        lastVersionSeen: 5,
        lastAutoUpdateAt: { at: START },
      }),
    );
    const pacing = install.launch("1.2.3");

    expect(await pacing.isAutomaticCheckDue()).toBe(true);
    expect(await pacing.isInUpdateCooldown()).toBe(false);
  });

  it("drops timestamps that are not real times", async () => {
    const install = await createInstall();
    for (const timestamp of ["-1", "1e400", "NaN"]) {
      await writeFile(
        install.filePath,
        `{"lastAutoCheckAt": ${timestamp}, "lastVersionSeen": "1.2.3", "lastAutoUpdateAt": ${timestamp}}`,
      );
      const pacing = install.launch("1.2.3");

      expect(await pacing.isAutomaticCheckDue()).toBe(true);
      expect(await pacing.isInUpdateCooldown()).toBe(false);
    }
  });

  it("keeps the valid fields next to a damaged one", async () => {
    const install = await createInstall();
    await writeFile(
      install.filePath,
      JSON.stringify({
        lastAutoCheckAt: START,
        lastVersionSeen: "1.2.3",
        lastAutoUpdateAt: "garbage",
        futureField: true,
      }),
    );
    const pacing = install.launch("1.2.3");

    expect(await pacing.isAutomaticCheckDue()).toBe(false);
    expect(await pacing.isInUpdateCooldown()).toBe(false);
  });

  it("ignores a temp file left behind by a crash in the middle of a write", async () => {
    const install = await createInstall();
    await install.launch("1.2.3").recordAutomaticCheck();
    await writeFile(`${install.filePath}.tmp.999.crashed`, '{"lastAutoCheckAt": 1');

    const pacing = install.launch("1.2.3");
    expect(await pacing.isAutomaticCheckDue()).toBe(false);
    expect(install.errors).toEqual([]);
  });

  it("leaves one complete file after every write", async () => {
    const install = await createInstall();
    const pacing = install.launch("1.2.3");

    await Promise.all(
      Array.from({ length: 25 }, async () => {
        await pacing.recordAutomaticCheck();
        await pacing.isAutomaticCheckDue();
      }),
    );

    expect(await readdir(path.dirname(install.filePath))).toEqual(["app-update-pacing.json"]);
    expect(await install.readFile()).toEqual({
      lastAutoCheckAt: START,
      lastVersionSeen: "1.2.3",
      lastAutoUpdateAt: null,
    });
  });
});

describe("pacing state that cannot be stored", () => {
  it("never throttles checks and never starts a cooldown when the file cannot be written", async () => {
    const userData = await createUserData();
    const blocker = path.join(userData, "not-a-directory");
    await writeFile(blocker, "");
    const install = await createInstall({ filePath: path.join(blocker, "app-update-pacing.json") });

    for (const version of ["1.2.3", "1.2.4", "1.2.5"]) {
      const pacing = install.launch(version);
      await pacing.recordAutomaticCheck();

      expect(await pacing.isAutomaticCheckDue()).toBe(true);
      expect(await pacing.isInUpdateCooldown()).toBe(false);
    }
    expect(install.errors.length).toBeGreaterThan(0);
  });

  // Windows has no directory write permission to revoke, and root ignores it.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "does not restart the cooldown on every launch when a version advance cannot be stored",
    async () => {
      const install = await createInstall();
      await install.launch("1.2.3").start();
      const stateDir = path.dirname(install.filePath);

      await chmod(stateDir, 0o555);
      try {
        for (let launch = 0; launch < 3; launch += 1) {
          install.advance(HOUR_MS);
          const pacing = install.launch("1.2.4");
          expect(await pacing.isInUpdateCooldown()).toBe(false);
          await pacing.recordAutomaticCheck();
          expect(await pacing.isAutomaticCheckDue()).toBe(true);
        }
        expect(await install.readFile()).toMatchObject({ lastVersionSeen: "1.2.3" });
        expect(install.errors.length).toBeGreaterThan(0);
      } finally {
        await chmod(stateDir, 0o755);
      }
    },
  );

  it("keeps the last stored check time when a later write fails", async () => {
    const userData = await createUserData();
    const stateDir = path.join(userData, "state");
    await mkdir(stateDir);
    const install = await createInstall({
      filePath: path.join(stateDir, "app-update-pacing.json"),
    });
    const pacing = install.launch("1.2.3");
    await pacing.recordAutomaticCheck();

    await rm(stateDir, { recursive: true });
    await writeFile(stateDir, "");
    install.advance(AUTOMATIC_CHECK_INTERVAL_MS);
    await pacing.recordAutomaticCheck();

    expect(await pacing.isAutomaticCheckDue()).toBe(true);
  });

  it("treats an unreadable file as a fresh install", async () => {
    const install = await createInstall();
    await mkdir(install.filePath);
    const pacing = install.launch("1.2.3");

    expect(await pacing.isAutomaticCheckDue()).toBe(true);
    expect(await pacing.isInUpdateCooldown()).toBe(false);
    await expect(pacing.recordAutomaticCheck()).resolves.toBeUndefined();
    expect(install.errors.length).toBeGreaterThan(0);
  });

  it("drops a change when the finished file cannot replace the stored one", async () => {
    const install = await createInstall();
    // A directory at the file path lets the temp file be written but not renamed into place.
    await mkdir(install.filePath);
    const pacing = install.launch("1.2.3");

    await pacing.recordAutomaticCheck();

    expect(await pacing.isAutomaticCheckDue()).toBe(true);
    expect(await readdir(path.dirname(install.filePath))).toEqual(["app-update-pacing.json"]);
  });

  it("stays open when the file path or the running version cannot be resolved", async () => {
    const errors: unknown[] = [];
    const brokenPath = createAppUpdatePacing({
      filePath: () => {
        throw new Error("userData is not available");
      },
      currentVersion: () => "1.2.3",
      now: () => START,
      reportError: (error) => errors.push(error),
    });
    const install = await createInstall();
    const brokenVersion = createAppUpdatePacing({
      filePath: () => install.filePath,
      currentVersion: () => {
        throw new Error("version is not available");
      },
      now: () => START,
      reportError: (error) => errors.push(error),
    });

    for (const pacing of [brokenPath, brokenVersion]) {
      await expect(pacing.start()).resolves.toBeUndefined();
      await expect(pacing.recordAutomaticCheck()).resolves.toBeUndefined();
      expect(await pacing.isAutomaticCheckDue()).toBe(true);
      expect(await pacing.isInUpdateCooldown()).toBe(false);
    }
    expect(errors.length).toBeGreaterThan(0);
  });
});
