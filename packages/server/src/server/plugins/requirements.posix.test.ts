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

it("installs plugins whose declared range excludes the daemon version", async () => {
  const root = await directory();
  await writePlugin(root, "^0.8.0");
  const { service, store } = await host("0.11.1");
  await expect(service.installDirectory({ path: root })).resolves.toMatchObject({
    status: "running",
  });
  expect(store.get().plugins.example?.enabled).toBe(true);
  expect(service.catalog()).toHaveLength(1);
});

it("starts, activates, and reloads plugins with missing or future requirements", async () => {
  const root = await directory();
  await writePlugin(root);
  const { service } = await host("0.11.1", root);
  expect(await service.listPlugins()).toEqual([expect.objectContaining({ status: "running" })]);
  await writePlugin(root, ">=99.0.0-beta.1");
  await expect(service.reloadPlugin("example")).resolves.toMatchObject({ status: "running" });
  await service.disablePlugin("example");
  await expect(service.enablePlugin("example")).resolves.toMatchObject({ status: "running" });
  expect(service.catalog()).toHaveLength(1);
});

it("rejects malformed requirements without persisting an installation", async () => {
  const root = await directory();
  await writePlugin(root, "not-semver");
  const { service, store } = await host("0.11.1");
  await expect(service.installDirectory({ path: root })).rejects.toThrow(
    "Invalid requirements.paseo",
  );
  expect(store.get().plugins).toEqual({});
  expect(service.catalog()).toEqual([]);
});

it("still rejects legacy plugins without a runtime entry", async () => {
  const root = await directory();
  await writePlugin(root, "^0.8.0");
  await rm(path.join(root, "index.client.ts"));
  await writeFile(path.join(root, "index.ts"), "export default () => () => {};");
  const { service } = await host("0.11.1");
  await expect(service.installDirectory({ path: root })).rejects.toThrow(
    "cannot run on Paseo v0.8",
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
  await writePlugin(repository, ">=99.0.0", [[process.execPath, "-e", "process.exit(1)"]]);
  await commit();
  const [preview] = await service.previewUpdates({ pluginId: "example" });
  expect(preview).toMatchObject({ outcome: "update" });
  await expect(service.applyUpdates([preview!.proposal!])).resolves.toMatchObject([
    { id: "example", outcome: "error" },
  ]);
  expect(await service.listPlugins()).toEqual([installed]);
  expect(service.catalog()).toHaveLength(1);
  expect(await readdir(path.join(home, "plugins", ".staging"))).toEqual([]);
  await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(service.installSource({ source, id: "second" })).rejects.toThrow();
  await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await service.listPlugins()).toEqual([installed]);
});
