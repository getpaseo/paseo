import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readManagedHostRegistry, resolveManagedHostRegistryPath } from "./registry";

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "paseo-managed-hosts-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("resolveManagedHostRegistryPath", () => {
  it("uses the configured file before the XDG default", () => {
    expect(
      resolveManagedHostRegistryPath({
        env: {
          PASEO_MANAGED_HOSTS_FILE: "/run/agenix/paseo-managed-hosts",
          XDG_CONFIG_HOME: "/ignored",
        },
        homeDirectory: "/home/ivan",
      }),
    ).toBe("/run/agenix/paseo-managed-hosts");
  });

  it("uses the Paseo XDG config path by default", () => {
    expect(
      resolveManagedHostRegistryPath({
        env: { XDG_CONFIG_HOME: "/home/ivan/.config" },
        homeDirectory: "/home/ivan",
      }),
    ).toBe("/home/ivan/.config/paseo/managed-hosts.json");
  });
});

describe("readManagedHostRegistry", () => {
  it("returns null when no managed registry exists", async () => {
    const homeDirectory = await createTemporaryDirectory();

    await expect(readManagedHostRegistry({ env: {}, homeDirectory })).resolves.toBeNull();
  });

  it("reads and validates the managed registry", async () => {
    const homeDirectory = await createTemporaryDirectory();
    const registryPath = path.join(homeDirectory, "fleet.json");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        hosts: [
          {
            label: "Ryzen",
            endpoint: "ryzen-shine:6767",
            password: "fleet-secret",
          },
        ],
      }),
    );

    await expect(
      readManagedHostRegistry({
        env: { PASEO_MANAGED_HOSTS_FILE: registryPath },
        homeDirectory,
      }),
    ).resolves.toEqual({
      version: 1,
      hosts: [
        {
          label: "Ryzen",
          endpoint: "ryzen-shine:6767",
          useTls: false,
          password: "fleet-secret",
        },
      ],
    });
  });
});
