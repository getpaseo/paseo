import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";
import type { HubCredentialStore, StoredHubCredential } from "./credentials.js";
import type { HubDaemonClient, HubStatus } from "./daemon-client.js";
import type { HubHttpClient } from "./hub-client/index.js";
import {
  continueHubGuidedSetup,
  runHubGuidedSetup,
  type HubGuidedSetupEnvironment,
} from "./init.js";
import { runHubLogin } from "./login.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("Hub guided setup continuation", () => {
  it("uses the login origin and connected daemon to validate, write, and deploy without replaying setup prompts", async () => {
    const cwd = await temporaryDirectory();
    const credentials = new MemoryCredentials();
    const daemon = new SetupDaemon();
    const prompts = new PromptAnswers(
      [true, true],
      ["codex", "gpt-5", "full-access", "slack"],
      ["U123"],
    );
    const calls: Array<{ operation: string; origin: string; files?: readonly string[] }> = [];
    const environment = setupEnvironment(cwd, credentials, daemon, prompts, calls);

    await runHubLogin(
      "https://hub.test",
      {},
      {
        env: {},
        credentials,
        flow: { authorize: async () => "paseo_cli_prefix_durable-secret" },
        isInteractive: () => true,
        continueGuidedSetup: (origin) => continueHubGuidedSetup(origin, environment),
        reporter: { progress() {} },
      },
    );

    assert.deepEqual(prompts.confirmations, [
      "Connect this daemon to https://hub.test?",
      "Initialize and deploy a starter workflow?",
    ]);
    assert.deepEqual(prompts.selections, [
      "Starter agent provider",
      "Starter agent model",
      "Starter agent mode",
      "Trigger provider",
    ]);
    assert.deepEqual(prompts.selectionOptions, [
      ["Codex (suggested)"],
      ["GPT-5 (suggested)", "GPT-5 mini"],
      ["Read only", "Full access (suggested)"],
      [
        "GitHub (issue or pull request comment)",
        "Slack (channel mention)",
        "Discord (channel mention)",
      ],
    ]);
    assert.deepEqual(calls, [
      { operation: "token", origin: "https://hub.test" },
      { operation: "projects", origin: "https://hub.test" },
      { operation: "setup", origin: "https://hub.test" },
      { operation: "resources", origin: "https://hub.test" },
      {
        operation: "validate",
        origin: "https://hub.test",
        files: [".paseo/hub.yml", ".paseo/workflows/slack-help.yml"],
      },
      {
        operation: "install",
        origin: "https://hub.test",
        files: [".paseo/hub.yml", ".paseo/workflows/slack-help.yml"],
      },
    ]);
    assert.equal(daemon.connections, 1);
    const hub = await readFile(path.join(cwd, ".paseo", "hub.yml"), "utf8");
    assert.match(hub, /daemon: macbook/u);
    assert.match(hub, /provider: codex\n    model: gpt-5\n    mode: full-access/u);
  });

  it("prints exact actionable resume commands for login continuation declines", async () => {
    const cwd = await temporaryDirectory();
    const credentials = new MemoryCredentials();
    credentials.save({ origin: "https://hub.test", credential: "secret" });
    const daemon = new SetupDaemon();
    const connectDeclined = new PromptAnswers([false], [], []);

    await continueHubGuidedSetup(
      "https://hub.test",
      setupEnvironment(cwd, credentials, daemon, connectDeclined, []),
    );
    assert.deepEqual(connectDeclined.messages, [
      "Skipped daemon connection. Run: paseo hub connect https://hub.test; then paseo hub init",
    ]);

    const initDeclined = new PromptAnswers([true, false], [], []);
    await continueHubGuidedSetup(
      "https://hub.test",
      setupEnvironment(cwd, credentials, daemon, initDeclined, []),
    );
    assert.deepEqual(initDeclined.messages, ["Skipped starter workflow. Run: paseo hub init"]);
  });

  it("keeps hub init's existing replacement confirmation", async () => {
    const cwd = await temporaryDirectory();
    await mkdir(path.join(cwd, ".paseo"));
    const prompts = new PromptAnswers([false], [], []);

    await assert.rejects(
      runHubGuidedSetup(
        setupEnvironment(cwd, new MemoryCredentials(), new SetupDaemon(), prompts, []),
      ),
      /Existing .paseo\/ bundle left unchanged/u,
    );
    assert.deepEqual(prompts.confirmations, ["Replace the existing .paseo/ Hub bundle?"]);
  });

  it("writes the explicitly selected Claude mode when the daemon has no default", async () => {
    const cwd = await temporaryDirectory();
    const credentials = new MemoryCredentials();
    credentials.save({ origin: "https://hub.test", credential: "secret" });
    const daemon = new SetupDaemon([
      {
        provider: "claude",
        status: "ready",
        enabled: true,
        models: [{ provider: "claude", id: "sonnet", label: "Sonnet", isDefault: true }],
        modes: [{ id: "auto", label: "Auto" }],
        defaultModeId: null,
      },
    ]);

    const prompts = new PromptAnswers([true], ["claude", "sonnet", "auto", "slack"], ["U123"]);
    const calls: Array<{ operation: string; origin: string; files?: readonly string[] }> = [];

    await runHubGuidedSetup(setupEnvironment(cwd, credentials, daemon, prompts, calls), {
      origin: "https://hub.test",
      daemonId: "daemon-1",
      deploy: true,
    });
    assert.deepEqual(prompts.selectionOptions.slice(0, 3), [
      ["claude"],
      ["Sonnet (suggested)"],
      ["Auto"],
    ]);
    assert.match(
      await readFile(path.join(cwd, ".paseo", "hub.yml"), "utf8"),
      /provider: claude\n    model: sonnet\n    mode: auto/u,
    );
    assert.deepEqual(
      calls.slice(-2).map(({ operation }) => operation),
      ["validate", "install"],
    );
  });
});

function setupEnvironment(
  cwd: string,
  credentials: HubCredentialStore,
  daemon: SetupDaemon,
  prompts: PromptAnswers,
  calls: Array<{ operation: string; origin: string; files?: readonly string[] }>,
): HubGuidedSetupEnvironment {
  const hub = {
    async issueEnrollmentToken(origin: string) {
      calls.push({ operation: "token", origin });
      return "one-time-enrollment-token-with-enough-length";
    },
    async listProjects(origin: string) {
      calls.push({ operation: "projects", origin });
      return [{ id: "a50e05af-4f20-4c8f-8dcc-58e5ea360663", slug: "studio", name: "Studio" }];
    },
    async listSetupResources(origin: string) {
      calls.push({ operation: "setup", origin });
      return {
        github: [],
        discord: [],
        slack: [{ teamId: "T123", teamName: "Paseo" }],
      };
    },
    async listConfigurationResources(origin: string) {
      calls.push({ operation: "resources", origin });
      return { daemons: [{ id: "daemon-1", slug: "macbook" }], github: [], discord: [], slack: [] };
    },
    async validateConfiguration(input: { origin: string; files: readonly { path: string }[] }) {
      calls.push({
        operation: "validate",
        origin: input.origin,
        files: input.files.map(({ path: filePath }) => filePath),
      });
      return { projectSlug: "studio", valid: true };
    },
    async installConfiguration(input: { origin: string; files: readonly { path: string }[] }) {
      calls.push({
        operation: "install",
        origin: input.origin,
        files: input.files.map(({ path: filePath }) => filePath),
      });
      return {
        projectSlug: "studio",
        version: 1,
        versionId: "a50e05af-4f20-4c8f-8dcc-58e5ea360663",
        active: true,
      };
    },
  } as HubHttpClient;
  return {
    env: {},
    credentials,
    hub,
    login: { authorize: async () => "paseo_cli_prefix_durable-secret" },
    daemon: { connect: async () => daemon },
    reporter: { progress() {} },
    cwd: () => cwd,
    isInteractive: () => true,
    prompts,
  };
}

class PromptAnswers {
  readonly confirmations: string[] = [];
  readonly selections: string[] = [];
  readonly selectionOptions: string[][] = [];
  readonly messages: string[] = [];

  constructor(
    private readonly confirmAnswers: boolean[],
    private readonly selectAnswers: string[],
    private readonly textAnswers: string[],
  ) {}

  async confirm(message: string): Promise<boolean> {
    this.confirmations.push(message);
    return this.confirmAnswers.shift() ?? false;
  }

  async select(options: {
    message: string;
    options?: { label: string; hint?: string }[];
  }): Promise<string> {
    this.selections.push(options.message);
    this.selectionOptions.push(
      options.options?.map(
        (option) => `${option.label}${option.hint ? ` (${option.hint})` : ""}`,
      ) ?? [],
    );
    return this.selectAnswers.shift() ?? "";
  }

  async text(): Promise<string> {
    return this.textAnswers.shift() ?? "";
  }

  message(value: string): void {
    this.messages.push(value);
  }
}

class MemoryCredentials implements HubCredentialStore {
  private record: StoredHubCredential | null = null;

  active(): StoredHubCredential | null {
    return this.record;
  }

  get(origin: string): StoredHubCredential | null {
    return this.record?.origin === origin ? this.record : null;
  }

  save(credential: StoredHubCredential): void {
    this.record = credential;
  }

  logoutActive(): StoredHubCredential | null {
    const record = this.record;
    this.record = null;
    return record;
  }
}

class SetupDaemon implements HubDaemonClient {
  connections = 0;
  private origin: string | null = null;

  constructor(
    private readonly providerEntries = [
      {
        provider: "codex",
        status: "ready" as const,
        enabled: true,
        label: "Codex",
        models: [
          { provider: "codex", id: "gpt-5", label: "GPT-5", isDefault: true },
          { provider: "codex", id: "gpt-5-mini", label: "GPT-5 mini" },
        ],
        modes: [
          { id: "read-only", label: "Read only" },
          { id: "full-access", label: "Full access" },
        ],
        defaultModeId: "full-access",
      },
    ],
  ) {}

  async connectHub(origin: string) {
    this.connections += 1;
    this.origin = origin;
    return { status: status(origin) };
  }

  async getHubStatus() {
    return { status: this.origin === null ? disconnectedStatus() : status(this.origin) };
  }

  async getProvidersSnapshot() {
    return { entries: this.providerEntries };
  }

  async disconnectHub() {
    return { status: disconnectedStatus() };
  }

  async close() {}
}

function status(origin: string): HubStatus {
  return {
    state: "connected",
    daemonId: "daemon-1",
    hubOrigin: origin,
    scopes: [],
    connectedAt: null,
    lastError: null,
  };
}

function disconnectedStatus(): HubStatus {
  return {
    state: "not_connected",
    daemonId: null,
    hubOrigin: null,
    scopes: [],
    connectedAt: null,
    lastError: null,
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-hub-init-flow-"));
  directories.push(directory);
  return directory;
}
