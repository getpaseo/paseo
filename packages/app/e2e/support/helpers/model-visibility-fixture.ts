import { setTimeout as delay } from "node:timers/promises";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { connectDaemonClient } from "./daemon-client-loader";
import { fork } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test as base, expect } from "../fixtures";
import { killProcessTree } from "./spawn-node";
import { seedWorkspace, type SeededWorkspace } from "./seed-client";

export interface CatalogProvider {
  id: string;
  label: string;
  models: { id: string; label: string; description?: string; isDefault?: boolean }[];
  additionalModels?: { id: string; label: string }[];
}

export const test = base.extend<
  { modelWorkspace: SeededWorkspace; catalogClient: DaemonClient },
  { catalogProvider: CatalogProvider }
>({
  catalogProvider: [
    { id: "unused", label: "Unused", models: [] },
    { scope: "worker", option: true },
  ],
  e2eWorker: async ({ catalogProvider }, provide) => {
    const scratch = await mkdtemp(path.join(tmpdir(), "paseo-catalog-"));
    const guardLog = path.join(scratch, "session-attempts.txt");
    await writeFile(guardLog, "");
    const child = fork(
      path.resolve(__dirname, "../../../../server/src/server/test-utils/catalog-daemon-process.ts"),
      {
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        env: {
          ...process.env,
          E2E_CATALOG_GUARD_LOG: guardLog,
          E2E_CATALOG_PROVIDERS: JSON.stringify({
            [catalogProvider.id]: {
              extends: "claude",
              label: catalogProvider.label,
              enabled: true,
              command: [process.execPath],
              models: catalogProvider.models,
              additionalModels: catalogProvider.additionalModels,
            },
          }),
        },
      },
    );
    const stderr: string[] = [];
    child.stdout?.resume();
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));
    let home: string | null = null;
    try {
      const ready = await new Promise<{ port: number; serverId: string; paseoHome: string }>(
        (resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`Catalog daemon startup timed out: ${stderr.join("")}`)),
            60_000,
          );
          child.once(
            "message",
            (message: { port: number; serverId: string; paseoHome: string }) => {
              clearTimeout(timer);
              resolve(message);
            },
          );
          child.once("exit", (code) => {
            clearTimeout(timer);
            reject(new Error(`Catalog daemon exited ${code}: ${stderr.join("")}`));
          });
        },
      );
      home = ready.paseoHome;
      process.env.E2E_DAEMON_PORT = String(ready.port);
      process.env.E2E_SERVER_ID = ready.serverId;
      process.env.E2E_PASEO_HOME = ready.paseoHome;
      await provide();
    } finally {
      if (child.connected) {
        const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        child.send("close");
        await Promise.race([exited, delay(10_000, undefined, { ref: false })]);
      }
      await killProcessTree(child);
      if (home) await rm(path.dirname(home), { recursive: true, force: true });
      const attempts = await readFile(guardLog, "utf8");
      await rm(scratch, { recursive: true, force: true });
      expect(attempts, "No provider sessions, including auxiliary naming").toBe("");
    }
  },
  catalogClient: async ({ catalogProvider }, provide) => {
    const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "model-visibility" });
    const original = (await client.getDaemonConfig()).config;
    try {
      await provide(client);
    } finally {
      await client.patchDaemonConfig({
        agentProfiles: original.agentProfiles ?? [],
        providers: {
          [catalogProvider.id]: {
            additionalModels: original.providers?.[catalogProvider.id]?.additionalModels ?? [],
            modelVisibility: Object.fromEntries(
              catalogProvider.models.map((model) => [model.id, true]),
            ),
          },
        },
      });
      await client.close();
    }
  },
  modelWorkspace: async ({ page, catalogProvider, catalogClient }, provide) => {
    void catalogClient;
    // Registered after the base seed, so reloads retain the same known selection.
    await page.addInitScript(
      ({ provider, model }) => {
        localStorage.setItem(
          "@paseo:create-agent-preferences",
          JSON.stringify({ provider, providerPreferences: { [provider]: { model } } }),
        );
      },
      { provider: catalogProvider.id, model: catalogProvider.models[0].id },
    );
    const workspace = await seedWorkspace({ repoPrefix: "model-catalog-", title: "Model catalog" });
    try {
      await provide(workspace);
    } finally {
      await workspace.cleanup();
    }
  },
});
export { expect };
