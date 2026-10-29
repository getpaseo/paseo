import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, onTestFinished, test } from "vitest";
import { settingsRpc } from "@getpaseo/plugin";
import { resolveDaemonVersion } from "../daemon-version.js";
import { runGitCommand } from "../../utils/run-git-command.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";

const SECRETS = ["sk-transfer-provider", "sk-transfer-registry", "sk-transfer-speech"];
const PASSWORD_HASH = `$2b$10$${"a".repeat(53)}`;

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function startDaemon(
  root: string,
  options: Parameters<typeof createTestPaseoDaemon>[0] = {},
  persisted?: Record<string, unknown>,
): Promise<{ daemon: TestPaseoDaemon; client: DaemonClient }> {
  const homeRoot = path.join(root, "home");
  await mkdir(path.join(homeRoot, ".paseo"), { recursive: true });
  if (persisted) {
    await writeFile(
      path.join(homeRoot, ".paseo", "config.json"),
      JSON.stringify({ version: 1, ...persisted }),
    );
  }
  const daemon = await createTestPaseoDaemon({
    paseoHomeRoot: homeRoot,
    staticDir: path.join(root, "static"),
    cleanup: false,
    ...options,
  });
  onTestFinished(() => daemon.close());
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.14.0",
  });
  onTestFinished(() => client.close());
  await client.connect();
  return { daemon, client };
}

async function createGitPlugin(root: string): Promise<{ remote: string; commit: string }> {
  const repository = path.join(root, "display-plugin");
  await mkdir(repository, { recursive: true });
  await writeFile(
    path.join(repository, "paseo-plugin.json"),
    JSON.stringify({
      id: "display-plugin",
      requirements: { paseo: `>=${resolveDaemonVersion(import.meta.url)}` },
    }),
  );
  await writeFile(
    path.join(repository, "index.server.ts"),
    `import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
export default function(server) {
  server.registerSettings(defineSettings({ id: "display", scope: "host", version: 1, schema: z.object({ enabled: z.boolean().default(true) }) }));
  return () => {};
}`,
  );
  await runGitCommand(["init", "-b", "main"], { cwd: repository });
  await runGitCommand(["add", "-A"], { cwd: repository });
  await runGitCommand(
    [
      "-c",
      "user.name=Paseo Tests",
      "-c",
      "user.email=paseo@example.test",
      "commit",
      "-m",
      "fixture",
    ],
    { cwd: repository },
  );
  const { stdout } = await runGitCommand(["rev-parse", "HEAD"], { cwd: repository });
  return { remote: pathToFileURL(repository).href, commit: stdout.trim() };
}

test("export leaves secrets and machine paths behind and lists each one", async () => {
  const root = await tempRoot("config-export-");
  const { client } = await startDaemon(
    root,
    {},
    {
      daemon: {
        auth: { password: PASSWORD_HASH },
        terminalProfiles: [{ id: "fish", name: "Fish", command: "/usr/local/bin/fish" }],
        appendSystemPrompt: "Be brief.",
      },
      agents: {
        providers: {
          claude: { env: { ANTHROPIC_API_KEY: SECRETS[0] }, command: ["/opt/claude/bin/claude"] },
        },
      },
      pluginRegistries: { "plugins.example.com": { authorization: `Bearer ${SECRETS[1]}` } },
      features: {
        dictation: {
          enabled: true,
          stt: { provider: "openai", apiKey: SECRETS[2], model: "gpt-4o-transcribe" },
        },
      },
    },
  );

  const { document } = await client.exportConfig();
  const serialized = JSON.stringify(document);

  for (const secret of [...SECRETS, PASSWORD_HASH]) expect(serialized).not.toContain(secret);
  expect(document.config).toEqual({
    profiles: { terminalProfiles: [{ id: "fish", name: "Fish", command: "/usr/local/bin/fish" }] },
    providers: { claude: { command: ["/opt/claude/bin/claude"] } },
    agentBehavior: { appendSystemPrompt: "Be brief." },
    speech: {
      dictation: { enabled: true, stt: { provider: "openai", model: "gpt-4o-transcribe" } },
    },
  });
  expect(document.redacted).toEqual([
    { path: "daemon.auth.password", kind: "secret" },
    { path: "pluginRegistries.plugins.example.com.authorization", kind: "secret" },
    { path: "daemon.terminalProfiles.0.command", kind: "machine-path" },
    { path: "agents.providers.claude.env", kind: "secret" },
    { path: "agents.providers.claude.command", kind: "machine-path" },
    { path: "features.dictation.stt.apiKey", kind: "secret" },
  ]);
}, 60_000);

test("a second daemon reinstalls an exported git plugin at its revision and restores its settings", async () => {
  const root = await tempRoot("config-transfer-");
  const plugin = await createGitPlugin(root);
  const rpc = settingsRpc("display");

  const source = await startDaemon(
    path.join(root, "a"),
    { pluginsEnabled: true },
    {
      daemon: { appendSystemPrompt: "From machine A." },
    },
  );
  await source.client.installPluginSource({ source: `git:${plugin.remote}` });
  const read = rpc.read.output.parse(
    await source.client.invokePluginRpc("display-plugin", rpc.read.name, {}),
  );
  await source.client.invokePluginRpc("display-plugin", rpc.write.name, {
    revision: read.revision,
    values: { enabled: false },
  });
  const { document } = await source.client.exportConfig();
  expect(document.plugins).toEqual([
    {
      id: "display-plugin",
      enabled: true,
      installation: expect.objectContaining({ currentRevision: plugin.commit }),
    },
  ]);
  expect(document.pluginSettings).toEqual([
    { pluginId: "display-plugin", settingsId: "display", version: 1, values: { enabled: false } },
  ]);

  const alreadyThere = path.join(root, "already-there");
  await mkdir(alreadyThere);
  const target = await startDaemon(path.join(root, "b"), {
    pluginsEnabled: false,
    plugins: { "already-there": { source: "directory", path: alreadyThere, enabled: true } },
  });

  const preview = await target.client.previewConfigImport(document);
  expect(preview).toMatchObject({
    sections: [
      { id: "agentBehavior", status: "ready", changes: ["appendSystemPrompt"], issues: [] },
    ],
    plugins: [{ id: "display-plugin", status: "install", source: `git:${plugin.remote}` }],
    requiresPluginsEnabled: true,
    pluginsStartedByEnabling: ["already-there"],
  });

  const unticked = await target.client.applyConfigImport({
    document,
    sections: ["agentBehavior"],
    plugins: [],
    enablePlugins: false,
  });
  expect(unticked.results).toEqual([{ item: "section:agentBehavior", outcome: "applied" }]);
  expect((await target.client.getDaemonConfig()).config.appendSystemPrompt).toBe("From machine A.");
  expect((await target.client.listPlugins()).map((item) => item.id)).toEqual(["already-there"]);

  const pluginsOff = await target.client.applyConfigImport({
    document,
    sections: [],
    plugins: ["display-plugin"],
    enablePlugins: false,
  });
  expect(pluginsOff.results).toEqual([
    {
      item: "plugin:display-plugin",
      outcome: "skipped",
      reason: "plugins are turned off on this host",
    },
  ]);

  const applied = await target.client.applyConfigImport({
    document,
    sections: [],
    plugins: ["display-plugin"],
    enablePlugins: true,
  });
  expect(applied.results).toEqual([
    { item: "pluginsEnabled", outcome: "applied" },
    { item: "plugin:display-plugin", outcome: "applied" },
    { item: "settings:display-plugin/display", outcome: "applied" },
  ]);
  const installed = (await target.client.listPlugins()).find(
    (item) => item.id === "display-plugin",
  );
  expect(installed).toMatchObject({
    status: "running",
    installation: expect.objectContaining({ currentRevision: plugin.commit }),
  });
  expect(
    rpc.read.output.parse(await target.client.invokePluginRpc("display-plugin", rpc.read.name, {})),
  ).toMatchObject({ status: "ready", values: { enabled: false } });
}, 180_000);

test("a plugin that cannot be installed is reported while the rest of the import applies", async () => {
  const root = await tempRoot("config-transfer-failure-");
  const { client } = await startDaemon(root, { pluginsEnabled: true });
  const missing = pathToFileURL(path.join(root, "no-such-repository")).href;

  const { results } = await client.applyConfigImport({
    document: {
      format: "paseo-host-config",
      version: 1,
      config: { agentBehavior: { autoArchiveAfterMerge: true } },
      plugins: [
        {
          id: "missing-plugin",
          enabled: true,
          installation: { identity: { kind: "git", remote: missing, pluginPath: "." } },
        },
      ],
      manualPlugins: [],
      pluginSettings: [],
      redacted: [],
    },
    sections: ["agentBehavior"],
    plugins: ["missing-plugin"],
    enablePlugins: false,
  });

  expect(results).toEqual([
    { item: "section:agentBehavior", outcome: "applied" },
    { item: "plugin:missing-plugin", outcome: "failed", reason: expect.any(String) },
  ]);
  expect((await client.getDaemonConfig()).config.autoArchiveAfterMerge).toBe(true);
  expect(await client.listPlugins()).toEqual([]);
}, 120_000);

test("a section the target cannot read is refused before anything is written", async () => {
  const root = await tempRoot("config-transfer-invalid-");
  const { client } = await startDaemon(root);
  const document = {
    format: "paseo-host-config" as const,
    version: 1,
    config: {
      agentBehavior: { autoArchiveAfterMerge: true },
      profiles: { agentProfiles: [], futureProfiles: [] },
    },
    plugins: [],
    manualPlugins: [],
    pluginSettings: [],
    redacted: [],
  };

  const preview = await client.previewConfigImport(document);
  expect(preview.sections).toEqual([
    { id: "agentBehavior", status: "ready", changes: ["autoArchiveAfterMerge"], issues: [] },
    {
      id: "profiles",
      status: "invalid",
      changes: [],
      issues: ['profiles: Unrecognized key: "futureProfiles"'],
    },
  ]);
  await expect(
    client.applyConfigImport({
      document,
      sections: ["agentBehavior", "profiles"],
      plugins: [],
      enablePlugins: false,
    }),
  ).rejects.toThrow(/Cannot apply invalid sections: profiles: Unrecognized key/);
  expect((await client.getDaemonConfig()).config.autoArchiveAfterMerge).toBe(false);
}, 60_000);
