import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";
import type { HubCredentialStore, StoredHubCredential } from "./credentials.js";
import { HubCommandError } from "./error.js";
import { runHubExport } from "./export.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("Hub trigger export", () => {
  it("uses the active login and writes one self-contained YAML file per trigger", async () => {
    const cwd = await temporaryDirectory();
    const credentials = new MemoryCredentials({
      origin: "https://hub.test",
      credential: "stored-secret",
    });
    const requests: Array<{ origin: string; credential: string }> = [];

    const result = await runHubExport(
      undefined,
      {},
      {
        cwd: () => cwd,
        env: {},
        credentials,
        reporter: { progress() {} },
        hub: {
          async listTriggers(origin, credential) {
            requests.push({ origin, credential });
            return [
              {
                id: "a50e05af-4f20-4c8f-8dcc-58e5ea360663",
                name: "slack-help",
                enabled: true,
                format: "single_run",
                yaml: "name: slack-help\nenabled: true\n",
              },
            ];
          },
        },
      },
    );

    assert.deepEqual(requests, [{ origin: "https://hub.test", credential: "stored-secret" }]);
    assert.equal(
      await readFile(path.join(cwd, ".paseo", "triggers", "slack-help.yml"), "utf8"),
      "name: slack-help\nenabled: true\n",
    );
    assert.deepEqual(result.data, {
      origin: "https://hub.test",
      directory: path.join(cwd, ".paseo", "triggers"),
      exported: 1,
      unchanged: 0,
    });
  });

  it("leaves identical files alone and refuses to overwrite changed files without --force", async () => {
    const cwd = await temporaryDirectory();
    const destination = path.join(cwd, "trigger.yml");
    const credentials = new MemoryCredentials({ origin: "https://hub.test", credential: "secret" });
    const dependencies = {
      cwd: () => cwd,
      env: {},
      credentials,
      reporter: { progress() {} },
      hub: {
        listTriggers: async () => [
          {
            id: "a50e05af-4f20-4c8f-8dcc-58e5ea360663",
            name: "trigger",
            enabled: true,
            format: "single_run" as const,
            yaml: "name: trigger\n",
          },
        ],
      },
    };
    await writeFile(destination, "name: trigger\n");
    assert.equal((await runHubExport(".", {}, dependencies)).data.unchanged, 1);

    await writeFile(destination, "local changes\n");
    await assert.rejects(runHubExport(".", {}, dependencies), (error: unknown) => {
      assert.ok(error instanceof HubCommandError);
      assert.equal(error.code, "HUB_EXPORT_CONFLICT");
      return true;
    });
    await runHubExport(".", { force: true }, dependencies);
    assert.equal(await readFile(destination, "utf8"), "name: trigger\n");
  });
});

class MemoryCredentials implements HubCredentialStore {
  constructor(private readonly record: StoredHubCredential) {}

  active(): StoredHubCredential {
    return this.record;
  }

  get(origin: string): StoredHubCredential | null {
    return origin === this.record.origin ? this.record : null;
  }

  save(): void {}
  logoutActive(): StoredHubCredential {
    return this.record;
  }
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-hub-export-"));
  directories.push(directory);
  return directory;
}
