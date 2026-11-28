import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll } from "vitest";

export function isolatePaseoHome(): void {
  let previousHome: string | undefined;
  let home: string | undefined;

  beforeAll(async () => {
    previousHome = process.env.PASEO_HOME;
    home = await mkdtemp(path.join(tmpdir(), "paseo-test-home-"));
    process.env.PASEO_HOME = home;
  });

  afterAll(async () => {
    if (previousHome === undefined) {
      delete process.env.PASEO_HOME;
    } else {
      process.env.PASEO_HOME = previousHome;
    }
    if (home) {
      await rm(home, { recursive: true, force: true, maxRetries: 3 });
    }
  });
}
