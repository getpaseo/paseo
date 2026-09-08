import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pino from "pino";
import { afterEach, expect, it } from "vitest";
import { DaemonConfigStore } from "../daemon-config-store.js";
import { runGitCommand } from "../../utils/run-git-command.js";
import { PluginService } from "./index.js";
import { ManagedPluginSources } from "./managed-source.js";

const roots: string[] = [];
const services: PluginService[] = [];
async function directory() {
  const root = await mkdtemp(path.join(tmpdir(), "plugin-requirements-"));
  roots.push(root);
  return root;
}
async function writePlugin(root: string, paseo?: string, build?: string[][]) {
  await writeFile(
    path.join(root, "paseo-plugin.json"),
    JSON.stringify({
      id: "example",
      requirements: paseo === undefined ? undefined : { paseo },
      build,
    }),
  );
  await writeFile(
    path.join(root, "index.client.ts"),
    "export default function contribute() { return () => {}; }",
  );
}
async function host(version = "0.8.0", pluginPath?: string) {
  const home = await directory();
  const store = new DaemonConfigStore(home, {
    mcp: { injectIntoAgents: true },
    browserTools: { enabled: false },
    providers: {},
    metadataGeneration: { providers: [] },
    autoArchiveAfterMerge: false,
    enableTerminalAgentHooks: false,
    appendSystemPrompt: "",
    pluginsEnabled: true,
    plugins: pluginPath
      ? { example: { source: "directory", path: pluginPath, enabled: true } }
      : {},
  });
  const service = new PluginService(pino({ level: "silent" }), store, version, {
    managedSources: new ManagedPluginSources(home),
  });
  services.push(service);
  await service.start();
  return { home, store, service };
}
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stopAllPlugins()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("rejects incompatible installs without persisting them, then accepts the corrected manifest", async () => {
  const root = await directory();
  await writePlugin(root, ">=0.9.0");
  const { service, store } = await host();
  await expect(service.installDirectory({ path: root })).rejects.toThrow("Your daemon is 0.8.0");
  expect(store.get().plugins).toEqual({});
  expect(service.catalog()).toEqual([]);
  await writePlugin(root, "^0.8.0");
  await expect(service.installDirectory({ path: root })).resolves.toMatchObject({
    status: "running",
  });
  expect(service.catalog()).toEqual([
    { id: "example", requirements: { paseo: "^0.8.0" }, clientBundle: expect.any(String) },
  ]);
});

it("marks pre-0.8 plugins failed on startup and recovers after migration and reload", async () => {
  const root = await directory();
  await writePlugin(root);
  const { service } = await host("0.8.0", root);
  expect(service.listPlugins()).toEqual([
    expect.objectContaining({
      status: "failed",
      error: expect.stringContaining("https://paseo.sh/docs/plugins/v0.8/migration"),
    }),
  ]);
  await writePlugin(root, ">=0.8.0");
  await expect(service.reloadPlugin("example")).resolves.toMatchObject({ status: "running" });
  await writePlugin(root, ">=0.9.0");
  await expect(service.reloadPlugin("example")).rejects.toThrow("requires Paseo >=0.9.0");
  expect(service.catalog()).toEqual([]);
});

it("still requires entry migration when an old plugin adds a compatible requirement", async () => {
  const root = await directory();
  await writePlugin(root, ">=0.8.0");
  await rm(path.join(root, "index.client.ts"));
  await writeFile(path.join(root, "index.ts"), "export default () => () => {};");
  const { service } = await host();
  await expect(service.installDirectory({ path: root })).rejects.toThrow(
    "https://paseo.sh/docs/plugins/v0.8/migration",
  );
});

it("rejects Git install and update before build commands, preserving the running revision", async () => {
  const repository = await directory();
  await runGitCommand(["init", "-b", "main"], { cwd: repository });
  await runGitCommand(["config", "user.name", "Paseo Tests"], { cwd: repository });
  await runGitCommand(["config", "user.email", "tests@example.test"], { cwd: repository });
  const commit = async () => {
    await runGitCommand(["add", "-A"], { cwd: repository });
    await runGitCommand(["commit", "-m", "plugin"], { cwd: repository });
  };
  await writePlugin(repository, ">=0.8.0");
  await commit();
  const { service, home } = await host();
  const source = pathToFileURL(repository).href;
  const installed = await service.installSource({ source });
  const marker = path.join(home, "build-executed");
  await writePlugin(repository, ">=0.9.0", [
    [process.execPath, "-e", 'require("node:fs").writeFileSync(process.argv[1], "ran")', marker],
  ]);
  await commit();
  await expect(service.updateSources("example")).rejects.toThrow("requires Paseo >=0.9.0");
  expect(service.listPlugins()).toEqual([installed]);
  expect(service.catalog()).toHaveLength(1);
  expect(await readdir(path.join(home, "plugins", ".staging"))).toEqual([]);
  await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(service.installSource({ source, id: "second" })).rejects.toThrow(
    "requires Paseo >=0.9.0",
  );
  await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  expect(service.listPlugins()).toEqual([installed]);
});
