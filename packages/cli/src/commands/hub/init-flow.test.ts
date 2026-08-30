import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
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
  it("offers daemon connection after login, then points to Hub without scaffolding files", async () => {
    const cwd = await temporaryDirectory();
    const credentials = new MemoryCredentials();
    const daemon = new SetupDaemon();
    const prompts = new PromptAnswers([true, false], [], []);
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
      "Connect this daemon to Paseo Hub?\n\nConnecting lets Hub identify this daemon and show whether it is online.\nIt does not allow Hub to create workspaces or run agents.",
      "Allow Hub automations to run agents on this daemon?\n\nThis lets workflows triggered from GitHub, Slack, Discord, Linear, and other integrations create workspaces and run agents here.\n\nAgents can access files and run commands allowed by their workspace runtime.",
    ]);
    assert.deepEqual(prompts.selections, []);
    assert.deepEqual(prompts.messages, [
      "Daemon connected with no permissions.\n\nEnable Hub automations later:\n  paseo hub permissions grant hub.execute",
      "Configure triggers in Hub: https://hub.test/triggers\nOr scaffold triggers as code: paseo hub init",
    ]);
    assert.deepEqual(calls, [{ operation: "token", origin: "https://hub.test" }]);
    assert.equal(daemon.connections, 1);
    assert.deepEqual(daemon.snapshotCwds, []);
    await assert.rejects(readFile(path.join(cwd, ".paseo", "hub.yml")), { code: "ENOENT" });
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
      "Skipped daemon connection. Connect later with: paseo hub connect https://hub.test",
      "Configure triggers in Hub: https://hub.test/triggers\nOr scaffold triggers as code: paseo hub init",
    ]);
  });

  it("does not reopen onboarding or widen permissions for an existing connection", async () => {
    const cwd = await temporaryDirectory();
    const credentials = new MemoryCredentials();
    credentials.save({ origin: "https://hub.test", credential: "secret" });
    const daemon = new SetupDaemon();
    await daemon.connectHub("https://hub.test", "existing-token", []);
    const prompts = new PromptAnswers([], [], []);

    await continueHubGuidedSetup(
      "https://hub.test",
      setupEnvironment(cwd, credentials, daemon, prompts, []),
    );

    assert.deepEqual(prompts.confirmations, []);
    assert.deepEqual(prompts.messages, [
      "This daemon is already connected to https://hub.test. Permissions: None.",
      "Configure triggers in Hub: https://hub.test/triggers\nOr scaffold triggers as code: paseo hub init",
    ]);
  });

  it("does not require a Hub app connection during login", async () => {
    const cwd = await temporaryDirectory();
    const credentials = new MemoryCredentials();
    const daemon = new SetupDaemon();
    const prompts = new PromptAnswers([false], [], []);

    await runHubLogin(
      "https://hub.test",
      {},
      {
        env: {},
        credentials,
        flow: { authorize: async () => "paseo_cli_prefix_durable-secret" },
        isInteractive: () => true,
        continueGuidedSetup: (origin) =>
          continueHubGuidedSetup(
            origin,
            setupEnvironment(cwd, credentials, daemon, prompts, [], {
              setupResources: { github: [], slack: [], discord: [] },
            }),
          ),
        reporter: { progress() {} },
      },
    );

    assert.deepEqual(prompts.messages, [
      "Skipped daemon connection. Connect later with: paseo hub connect https://hub.test",
      "Configure triggers in Hub: https://hub.test/triggers\nOr scaffold triggers as code: paseo hub init",
    ]);
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

    const prompts = new PromptAnswers([true], ["claude", "sonnet", "auto"], ["U123"]);
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

  it("stops before runtime discovery and file writes when no Hub app connection is usable", async () => {
    const cwd = await temporaryDirectory();
    const credentials = new MemoryCredentials();
    credentials.save({ origin: "https://hub.test", credential: "secret" });
    const daemon = new SetupDaemon();
    const prompts = new PromptAnswers([], [], []);

    await assert.rejects(
      runHubGuidedSetup(
        setupEnvironment(cwd, credentials, daemon, prompts, [], {
          setupResources: { github: [], slack: [], discord: [] },
        }),
        { origin: "https://hub.test", daemonId: "daemon-1", deploy: true },
      ),
      /No Hub app connection is ready for this workflow/u,
    );

    assert.equal(daemon.snapshotCwds.length, 0);
    await assert.rejects(readFile(path.join(cwd, ".paseo", "hub.yml")), { code: "ENOENT" });
  });

  it("waits for fresh-daemon provider discovery before offering runtime choices", async () => {
    const cwd = await temporaryDirectory();
    const credentials = new MemoryCredentials();
    credentials.save({ origin: "https://hub.test", credential: "secret" });
    const ready = new SetupDaemon().providerEntries;
    const daemon = new SetupDaemon(ready, [
      [{ provider: "codex", status: "loading", enabled: true }],
      ready,
    ]);
    const prompts = new PromptAnswers([], ["codex", "gpt-5", "full-access"], ["U123"]);

    await runHubGuidedSetup(setupEnvironment(cwd, credentials, daemon, prompts, []), {
      origin: "https://hub.test",
      daemonId: "daemon-1",
      deploy: true,
    });

    assert.equal(daemon.snapshotCwds.length, 2);
    assert.deepEqual(prompts.selections.slice(0, 3), [
      "Starter agent provider",
      "Starter agent model",
      "Starter agent mode",
    ]);
  });
});

function setupEnvironment(
  cwd: string,
  credentials: HubCredentialStore,
  daemon: SetupDaemon,
  prompts: PromptAnswers,
  calls: Array<{ operation: string; origin: string; files?: readonly string[] }>,
  options: {
    setupResources?: Awaited<ReturnType<HubHttpClient["listSetupResources"]>>;
  } = {},
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
      return (
        options.setupResources ?? {
          github: [],
          discord: [],
          slack: [{ teamId: "T123", teamName: "Paseo" }],
        }
      );
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
  readonly snapshotCwds: Array<string | undefined> = [];
  private origin: string | null = null;
  private currentPermissions: string[] = [];

  constructor(
    readonly providerEntries: readonly ProviderSnapshotEntry[] = [
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
    private readonly providerEntrySequence?: readonly (readonly ProviderSnapshotEntry[])[],
  ) {}

  async connectHub(origin: string, _token: string, permissions: readonly string[] = []) {
    this.connections += 1;
    this.origin = origin;
    this.currentPermissions = [...permissions];
    return { status: status(origin, permissions) };
  }

  async updateHubPermissions(input: { grant?: readonly string[]; revoke?: readonly string[] }) {
    const permissions = new Set(this.origin === null ? [] : this.currentPermissions);
    for (const permission of input.revoke ?? []) permissions.delete(permission);
    for (const permission of input.grant ?? []) permissions.add(permission);
    this.currentPermissions = [...permissions];
    return { status: status(this.origin ?? "https://hub.test", this.currentPermissions) };
  }

  async getHubStatus() {
    return {
      status:
        this.origin === null ? disconnectedStatus() : status(this.origin, this.currentPermissions),
    };
  }

  async getProvidersSnapshot(options?: { cwd?: string }) {
    this.snapshotCwds.push(options?.cwd);
    const index = Math.min(
      this.snapshotCwds.length - 1,
      (this.providerEntrySequence?.length ?? 1) - 1,
    );
    return { entries: this.providerEntrySequence?.[index] ?? this.providerEntries };
  }

  async disconnectHub() {
    return { status: disconnectedStatus() };
  }

  async close() {}
}

function status(origin: string, permissions: readonly string[] = []): HubStatus {
  return {
    state: "connected",
    daemonId: "daemon-1",
    hubOrigin: origin,
    permissions: [...permissions],
    connectedAt: null,
    lastError: null,
  };
}

function disconnectedStatus(): HubStatus {
  return {
    state: "not_connected",
    daemonId: null,
    hubOrigin: null,
    permissions: [],
    connectedAt: null,
    lastError: null,
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-hub-init-flow-"));
  directories.push(directory);
  return directory;
}
