import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProviderCliService, type ProviderCliServiceOptions } from "./provider-cli-service";

const FAKE_CLAUDE = `#!/bin/sh
STATE="$(dirname "$0")/claude-version"
case "$1" in
  --version) echo "$(cat "$STATE") (Claude Code)" ;;
  auth) echo '{"loggedIn":true,"email":"dev@example.com"}' ;;
  update) echo "2.0.0" > "$STATE"; echo "Updated to 2.0.0" ;;
  *) exit 1 ;;
esac
`;

describe.skipIf(process.platform === "win32")("ProviderCliService", () => {
  let dir: string;
  let services: ProviderCliService[];
  let changed: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "paseo-provider-cli-"));
    await writeFile(join(dir, "claude"), FAKE_CLAUDE);
    await chmod(join(dir, "claude"), 0o755);
    await writeFile(join(dir, "claude-version"), "1.0.0\n");
    services = [];
    changed = [];
  });

  afterEach(async () => {
    for (const service of services) service.close();
    await rm(dir, { recursive: true, force: true });
  });

  function createService(overrides: Partial<ProviderCliServiceOptions> = {}): ProviderCliService {
    const changedForTest = changed;
    const service = new ProviderCliService({
      logger: pino({ level: "silent" }),
      autoUpdate: false,
      getProviderOverride: () => ({ env: { PATH: `${dir}:/usr/bin:/bin` } }),
      isProviderBusy: () => false,
      onProviderChanged: (provider) => changedForTest.push(provider),
      fetchLatestVersion: async (npmPackage) =>
        npmPackage === "@anthropic-ai/claude-code" ? "2.0.0" : null,
      ...overrides,
    });
    services.push(service);
    return service;
  }

  async function claudeStatus(service: ProviderCliService) {
    const statuses = await service.listStatus({ refresh: true });
    return statuses.find((status) => status.provider === "claude");
  }

  it("reports the installed version, latest release, and account", async () => {
    const status = await claudeStatus(createService());

    expect(status).toMatchObject({
      installed: true,
      version: "1.0.0",
      latestVersion: "2.0.0",
      updateAvailable: true,
      managedExternally: false,
      update: { supported: true, status: "idle" },
      auth: { supported: true, status: "signed_in", account: "dev@example.com" },
      login: null,
    });
  });

  it("updates through the CLI's own updater and refreshes the provider", async () => {
    const service = createService();
    await claudeStatus(service);

    await service.startUpdate("claude");

    await expect.poll(async () => (await claudeStatus(service))?.update.status).toBe("succeeded");
    expect(await claudeStatus(service)).toMatchObject({ version: "2.0.0", updateAvailable: false });
    expect((await readFile(join(dir, "claude-version"), "utf8")).trim()).toBe("2.0.0");
    await expect.poll(() => changed).toContain("claude");
  });

  it("leaves a replaced command alone", async () => {
    const service = createService({
      getProviderOverride: () => ({ command: ["/opt/custom/claude"] }),
    });
    const status = await claudeStatus(service);

    expect(status).toMatchObject({
      installed: true,
      version: null,
      managedExternally: true,
      update: { supported: false },
      auth: { supported: false },
    });
    await expect(service.startUpdate("claude")).rejects.toThrow("cannot update claude");
  });

  it("reports providers whose CLI is missing as not installed", async () => {
    const statuses = await createService().listStatus({ refresh: true });

    expect(statuses.find((status) => status.provider === "copilot")).toMatchObject({
      installed: false,
      version: null,
      update: { supported: false },
    });
  });

  it("updates automatically when no agents are running", async () => {
    createService({ autoUpdate: true, autoUpdateInitialDelayMs: 0 });

    await expect.poll(() => changed).toContain("claude");
    expect((await readFile(join(dir, "claude-version"), "utf8")).trim()).toBe("2.0.0");
  });

  it("defers automatic updates while the provider is busy", async () => {
    const busyChecks: string[] = [];
    const service = createService({
      autoUpdate: true,
      autoUpdateInitialDelayMs: 0,
      isProviderBusy: (provider) => {
        busyChecks.push(provider);
        return provider === "claude";
      },
    });

    // The busy check is the last step before an update would start.
    await expect.poll(() => busyChecks).toContain("claude");

    const status = (await service.listStatus()).find((entry) => entry.provider === "claude");
    expect(status).toMatchObject({ version: "1.0.0", update: { status: "idle" } });
    expect(changed).toEqual([]);
  });
});
