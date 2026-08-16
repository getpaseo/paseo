import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

import { loadConfig, resolveBundledWebUiDistDir, resolveConfigFromPersisted } from "./config.js";
import { loadPersistedConfig } from "./persisted-config.js";
import { createWorkspaceRuntimeService } from "./workspace-runtime/index.js";

const roots: string[] = [];

describe("server config", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("records when the daemon is managed by Paseo Desktop", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-config-desktop-managed-"));
    roots.push(paseoHome);

    const desktopConfig = loadConfig(paseoHome, {
      env: { PASEO_DESKTOP_MANAGED: "1" },
    });
    const standaloneConfig = loadConfig(paseoHome, { env: {} });

    expect(desktopConfig.desktopManaged).toBe(true);
    expect(standaloneConfig.desktopManaged).toBe(false);
  });

  test("loads trusted external workspace runtime registrations", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-config-runtime-"));
    roots.push(paseoHome);
    const configPath = path.join(paseoHome, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        workspaceRuntimes: {
          fixture: {
            type: "command",
            command: ["/trusted/runtime", "--mode", "fixture"],
            options: { image: "fixture:test" },
          },
        },
      }),
    );
    await chmod(configPath, 0o600);

    expect(loadConfig(paseoHome, { env: {} }).workspaceRuntimes).toEqual({
      fixture: {
        type: "command",
        command: ["/trusted/runtime", "--mode", "fixture"],
        options: { image: "fixture:test" },
      },
    });
  });

  test("lets persisted registrations override or remove distribution registrations", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-config-runtime-merge-"));
    roots.push(paseoHome);
    const configPath = path.join(paseoHome, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        workspaceRuntimes: {
          removed: null,
          replaced: { type: "command", label: "User", command: ["user-runtime"] },
        },
      }),
    );
    await chmod(configPath, 0o600);

    expect(
      loadConfig(paseoHome, {
        env: {
          PASEO_DISTRIBUTION_WORKSPACE_RUNTIMES: JSON.stringify({
            removed: { type: "command", command: ["bundled-removed"] },
            replaced: { type: "command", command: ["bundled-replaced"] },
            retained: { type: "command", label: "Retained", command: ["bundled-retained"] },
          }),
        },
      }).workspaceRuntimes,
    ).toEqual({
      replaced: { type: "command", label: "User", command: ["user-runtime"] },
      retained: { type: "command", label: "Retained", command: ["bundled-retained"] },
    });
  });

  test("composes a configured executable for runtimeId selection and rejects others", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-config-runtime-compose-"));
    roots.push(paseoHome);
    const source = path.join(paseoHome, "source");
    const stateDirectory = path.join(paseoHome, "runtime-state");
    await Promise.all([mkdir(source), mkdir(stateDirectory)]);
    const fixtureExecutable = fileURLToPath(
      new URL("../../../../runtimes/fixture/src/index.mjs", import.meta.url),
    );
    const configPath = path.join(paseoHome, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        workspaceRuntimes: {
          fixture: {
            type: "command",
            command: [process.execPath, fixtureExecutable],
            options: { stateDirectory },
          },
        },
      }),
    );
    await chmod(configPath, 0o600);
    const config = loadConfig(paseoHome, { env: {} });
    const runtimeIds = new Map<string, string>();
    const service = createWorkspaceRuntimeService({
      paseoHome,
      externalRuntimes: config.workspaceRuntimes,
      resolveRuntimeId: async (workspaceId) => runtimeIds.get(workspaceId) ?? null,
      persistRuntimeId: async (workspaceId, runtimeId) => {
        runtimeIds.set(workspaceId, runtimeId);
      },
      beginWorkspaceDeletion: async () => {},
      removeWorkspaceRecord: async (workspaceId) => {
        runtimeIds.delete(workspaceId);
      },
    });
    const createInput = {
      workspaceId: "configured-runtime",
      runtimeId: "fixture",
      project: { id: "fixture", source: { kind: "host-directory" as const, path: source } },
      placement: { kind: "existing" as const },
    };

    await expect(service.create(createInput)).resolves.toEqual({
      workspaceId: "configured-runtime",
      runtimeId: "fixture",
      cwd: source,
      materializedFreshContent: true,
    });
    await expect(
      service.create({ ...createInput, workspaceId: "unknown-runtime", runtimeId: "unknown" }),
    ).rejects.toThrow("Workspace runtime is not registered: unknown");
    await service.destroy("configured-runtime");
    expect(runtimeIds.has("configured-runtime")).toBe(false);
  });

  test("loads the provider catalog refresh timeout", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-config-provider-timeout-"));
    roots.push(paseoHome);
    await writeFile(
      path.join(paseoHome, "config.json"),
      JSON.stringify({ agents: { catalogRefreshTimeoutMs: 180_000 } }),
    );

    const config = loadConfig(paseoHome, { env: {} });

    expect(config.providerCatalogRefreshTimeoutMs).toBe(180_000);
  });

  test("resolves reload state from the supplied validated snapshot", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-config-snapshot-"));
    roots.push(paseoHome);
    const snapshot = loadPersistedConfig(paseoHome);
    await writeFile(
      path.join(paseoHome, "config.json"),
      JSON.stringify({
        ...snapshot,
        daemon: { ...snapshot.daemon, browserTools: { enabled: true } },
      }),
    );

    expect(resolveConfigFromPersisted(paseoHome, snapshot, { env: {} }).browserToolsEnabled).toBe(
      false,
    );
    expect(loadConfig(paseoHome, { env: {} }).browserToolsEnabled).toBe(true);
  });

  test("records mutable and startup launch overrides by persisted leaf", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-config-overrides-"));
    roots.push(paseoHome);
    const config = loadConfig(paseoHome, {
      env: {
        PASEO_LISTEN: "127.0.0.1:7000",
        PASEO_PASSWORD: "secret",
        PASEO_RELAY_ENDPOINT: "relay.example.test:443",
        PASEO_TRUSTED_PROXIES: "true",
        PASEO_WEB_UI_ENABLED: "true",
        PASEO_LOG_FILE_PATH: "custom.log",
        PASEO_VOICE_LLM_PROVIDER: "codex",
      },
      cli: { relayUseTls: false },
    });

    expect(config.configReload?.overrideControlledPaths).toEqual([
      "daemon.auth.password",
      "daemon.listen",
      "daemon.relay.endpoint",
      "daemon.relay.useTls",
      "daemon.trustedProxies",
      "features.voiceMode.llm.provider",
      "features.webUi.enabled",
      "log.file.path",
    ]);
    expect(config.listen).toBe("127.0.0.1:7000");
    expect(config.trustedProxies).toBe(true);
    expect(config.log?.file?.path).toBe("custom.log");
    expect(config.voiceLlmProvider).toBe("codex");
  });

  test.each([
    {
      name: "local speech providers",
      providers: { dictation: "local", voiceStt: "local", voiceTts: "local" },
      expected: [
        "features.dictation.stt.model",
        "features.voiceMode.stt.model",
        "features.voiceMode.tts.model",
      ],
    },
    {
      name: "OpenAI speech providers",
      providers: { dictation: "openai", voiceStt: "openai", voiceTts: "openai" },
      expected: [
        "features.dictation.stt.confidenceThreshold",
        "features.dictation.stt.model",
        "features.voiceMode.stt.model",
        "features.voiceMode.tts.model",
        "features.voiceMode.tts.voice",
      ],
    },
    {
      name: "mixed local and OpenAI speech providers",
      providers: { dictation: "local", voiceStt: "openai", voiceTts: "local" },
      expected: [
        "features.dictation.stt.confidenceThreshold",
        "features.dictation.stt.model",
        "features.voiceMode.stt.model",
        "features.voiceMode.tts.model",
      ],
    },
  ])("classifies speech overrides for $name", ({ providers, expected }) => {
    const config = resolveConfigFromPersisted(
      "/tmp/paseo-speech-override-classification",
      {
        version: 1,
        features: {
          dictation: { enabled: true, stt: { provider: providers.dictation } },
          voiceMode: {
            enabled: true,
            stt: { provider: providers.voiceStt },
            tts: { provider: providers.voiceTts },
          },
        },
      },
      {
        env: {
          OPENAI_API_KEY: "test-api-key",
          PASEO_DICTATION_LOCAL_STT_MODEL: "parakeet-tdt-0.6b-v2-int8",
          PASEO_VOICE_LOCAL_STT_MODEL: "parakeet-tdt-0.6b-v2-int8",
          PASEO_VOICE_LOCAL_TTS_MODEL: "kokoro-en-v0_19",
          STT_CONFIDENCE_THRESHOLD: "0.5",
          STT_MODEL: "whisper-1",
          TTS_MODEL: "tts-1",
          TTS_VOICE: "alloy",
        },
      },
    );

    expect(config.configReload?.overrideControlledPaths).toEqual(expected);
  });

  test("resolves bundled web UI path from source-tree modules", () => {
    const root = path.parse(process.cwd()).root;
    expect(
      resolveBundledWebUiDistDir({
        moduleUrl: pathToFileURL(
          path.join(root, "repo", "packages", "server", "src", "server", "config.ts"),
        ),
      }),
    ).toBe(path.join(root, "repo", "packages", "server", "dist", "server", "web-ui"));
  });

  test("resolves bundled web UI path from globally installed compiled modules", async () => {
    const packageRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-config-compiled-"));
    roots.push(packageRoot);
    await mkdir(path.join(packageRoot, "dist", "server", "web-ui"), { recursive: true });

    expect(
      resolveBundledWebUiDistDir({
        moduleUrl: pathToFileURL(path.join(packageRoot, "dist", "server", "server", "config.js")),
      }),
    ).toBe(path.join(packageRoot, "dist", "server", "web-ui"));
  });

  test("resolves packaged desktop web UI path from resources app-dist", async () => {
    const packageRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-config-packaged-"));
    roots.push(packageRoot);
    await mkdir(path.join(packageRoot, "app-dist"), { recursive: true });

    expect(
      resolveBundledWebUiDistDir({
        moduleUrl: pathToFileURL(
          path.join(
            packageRoot,
            "app.asar",
            "node_modules",
            "@getpaseo",
            "server",
            "dist",
            "server",
            "server",
            "config.js",
          ),
        ),
        resourcesPath: packageRoot,
      }),
    ).toBe(path.join(packageRoot, "app-dist"));
  });
});
