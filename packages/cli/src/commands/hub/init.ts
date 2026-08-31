import {
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  note,
  outro,
  select,
  spinner,
  text,
} from "@clack/prompts";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Command } from "commander";
import { DEFAULT_HUB_ORIGIN, resolveHubCredential } from "./authority.js";
import type { HubCredentialStore } from "./credentials.js";
import type { HubDaemonConnection } from "./daemon-client.js";
import { withHubDaemon } from "./daemon-client.js";
import { HubCommandError } from "./error.js";
import type {
  HubConfigurationResources,
  HubHttpClient,
  HubProject,
  HubSetupResources,
} from "./hub-client/index.js";
import {
  createHubInitBundle,
  createHubInitScaffold,
  hubLoginResumeCommand,
  planHubInitOpening,
  resolveHubInitConnection,
  resolveHubInitProjects,
} from "./init-plan.js";
import type { CliLoginFlow } from "./login-flow.js";
import { runHubConnect } from "./connect.js";
import { runHubDeployBundle } from "./deploy.js";
import { runHubProjects } from "./projects.js";
import type { HubReporter } from "./reporter.js";
import { normalizeHubOrigin } from "./origin.js";
import {
  selectedStarterAgentRuntime,
  starterAgentProviderSnapshotState,
  suggestedStarterAgentChoice,
  type HubStarterAgentProvider,
  type HubStarterAgentRuntime,
} from "./starter-agent-runtime.js";
import {
  availableStarterTriggerConnections,
  type HubStarterTriggerConnection,
} from "./starter-trigger.js";

const execFileAsync = promisify(execFile);
const DAEMON_READY_TIMEOUT_MS = 60_000;
const DAEMON_READY_POLL_MS = 250;
const PROVIDER_READY_TIMEOUT_MS = 60_000;

export interface HubGuidedSetupEnvironment {
  env: Readonly<Record<string, string | undefined>>;
  credentials: HubCredentialStore;
  hub: HubHttpClient;
  login: Pick<CliLoginFlow, "authorize">;
  daemon: HubDaemonConnection;
  reporter: HubReporter;
  cwd(): string;
  isInteractive?(): boolean;
  prompts?: {
    confirm(message: string, initialValue: boolean): Promise<boolean>;
    select(options: Parameters<typeof select<string>>[0]): Promise<string>;
    text(options: Parameters<typeof text>[0]): Promise<string>;
    message(value: string): void;
  };
}

interface HubGuidedSetupState {
  origin?: string;
  daemonId?: string;
  deploy?: boolean;
}

class HubInitCancelledError extends Error {}

function initErrorMessage(error: unknown): string {
  if (error instanceof HubCommandError && error.details) {
    return `${error.message}\n${error.details}`;
  }
  return error instanceof Error ? error.message : String(error);
}

export function addHubInitCommand(parent: Command, environment: HubGuidedSetupEnvironment): void {
  parent
    .command("init")
    .description("Create and optionally deploy a safe starter Hub bundle")
    .action(async () => {
      try {
        await runHubInit(environment);
      } catch (error) {
        if (error instanceof HubInitCancelledError) {
          cancel(error.message);
          return;
        }
        cancel(initErrorMessage(error));
        process.exitCode = 1;
      }
    });
}

export async function runHubInit(environment: HubGuidedSetupEnvironment): Promise<void> {
  await runHubGuidedSetup(environment);
}

export async function runHubGuidedSetup(
  environment: HubGuidedSetupEnvironment,
  state: HubGuidedSetupState = {},
): Promise<void> {
  requireInteractiveTerminal(environment);
  intro("Set up Paseo Hub");

  const cwd = environment.cwd();
  const activeLogin = environment.credentials.active();
  const opening = planHubInitOpening({
    loggedIn: activeLogin !== null,
    paseoDirectoryExists: await pathExists(path.join(cwd, ".paseo")),
  });
  if (
    opening.replaceExisting &&
    !(await requiredConfirm(environment, "Replace the existing .paseo/ Hub bundle?", false))
  ) {
    throw new HubInitCancelledError("Existing .paseo/ bundle left unchanged.");
  }

  const origin = state.origin ?? (await ensureLogin(activeLogin?.origin, environment));
  const daemonId = state.daemonId ?? (await ensureDaemonConnection(origin, environment));
  const project = await chooseProject(origin, environment);
  const resources = await loadSetupResources(origin, environment);
  const triggerConnections = await resolveStarterTriggerConnections(resources, cwd);
  reportStarterTriggerConnections(environment, triggerConnections);
  const trigger = await chooseStarterTriggerConnection(environment, triggerConnections);
  const daemon = await loadDaemonResource(origin, daemonId, environment);
  log.success(`Connected as ${daemon.slug}`);
  const agent = await chooseStarterAgentRuntime(environment, cwd);
  const providerFilters = await collectProviderIdentity(trigger, environment);
  const scaffold = createHubInitScaffold({
    cwd,
    daemonSlug: daemon.slug,
    agent,
    provider: trigger.provider,
    providerFilters,
  });

  const bundle = createHubInitBundle(project.slug, scaffold);

  await withSpinner("Validating bundle", async () => {
    await runHubDeployBundle({ project: project.slug, hub: origin, dryRun: true }, bundle, {
      cwd,
      env: environment.env,
      credentials: environment.credentials,
      hub: environment.hub,
      reporter: { progress() {} },
    });
  });
  log.success("Dry run passed");
  await writeScaffold(cwd, scaffold, opening.replaceExisting);
  log.success(`Created .paseo/hub.yml and ${scaffold.workflowPath}`);

  const deploy = state.deploy ?? (await requiredConfirm(environment, "Deploy now?", true));
  if (deploy) {
    await withSpinner("Deploying bundle", async () => {
      await runHubDeployBundle({ project: project.slug, hub: origin }, bundle, {
        cwd,
        env: environment.env,
        credentials: environment.credentials,
        hub: environment.hub,
        reporter: { progress() {} },
      });
    });
    log.success("Deployed");
  } else {
    reportMessage(environment, `Skipped deployment. Run: paseo hub deploy -p ${project.slug}`);
  }

  const activityUrl = new URL(`/projects/${project.slug}/activity`, origin).toString();
  note(`${scaffold.testAction}\nWatch it at ${activityUrl}`, "Test your workflow");
  outro(deploy ? "Hub is ready" : "Hub bundle is ready");
}

export async function continueHubGuidedSetup(
  origin: string,
  environment: HubGuidedSetupEnvironment,
): Promise<void> {
  const currentStatus = await withHubDaemon(environment.daemon, undefined, async (daemon) =>
    daemon.getHubStatus().then((response) => response.status),
  );
  const current = resolveHubInitConnection(currentStatus, origin);
  if (current.kind === "connected") {
    reportMessage(
      environment,
      `This daemon is already connected to ${origin}. Permissions: ${
        currentStatus.permissions.join(", ") || "None"
      }.`,
    );
  } else if (current.kind === "pending") {
    await waitForDaemonReady(origin, environment.daemon);
  } else if (current.kind === "conflict") {
    reportMessage(
      environment,
      `This daemon is connected to ${current.origin}. Disconnect it before connecting to ${origin}.`,
    );
  } else if (
    await requiredConfirm(
      environment,
      "Connect this daemon to Paseo Hub?\n\nConnecting lets Hub identify this daemon and show whether it is online.\nIt does not allow Hub to create workspaces or run agents.",
      true,
    )
  ) {
    const grantExecution = await requiredConfirm(
      environment,
      "Allow Hub automations to run agents on this daemon?\n\nThis lets workflows triggered from GitHub, Slack, Discord, Linear, and other integrations create workspaces and run agents here.\n\nAgents can access files and run commands allowed by their workspace runtime.",
      false,
    );
    await ensureDaemonConnection(origin, environment, true, grantExecution ? ["hub.execute"] : []);
    if (!grantExecution) {
      reportMessage(
        environment,
        "Daemon connected with no permissions.\n\nEnable Hub automations later:\n  paseo hub permissions grant hub.execute",
      );
    }
  } else {
    reportMessage(
      environment,
      `Skipped daemon connection. Connect later with: ${hubLoginResumeCommand("connect", origin)}`,
    );
  }
  reportMessage(
    environment,
    `Configure triggers in Hub: ${new URL("/triggers", origin).toString()}\nOr scaffold triggers as code: ${hubLoginResumeCommand("init", origin)}`,
  );
}

async function ensureLogin(
  activeOrigin: string | undefined,
  environment: HubGuidedSetupEnvironment,
): Promise<string> {
  const endpoint = await requiredSelect(environment, {
    message: "Hub endpoint",
    initialValue:
      activeOrigin === undefined || activeOrigin === DEFAULT_HUB_ORIGIN ? "hosted" : "custom",
    options: [
      { value: "hosted", label: "hub.paseo.sh" },
      { value: "custom", label: "Custom endpoint…" },
    ],
  });
  const origin =
    endpoint === "hosted"
      ? DEFAULT_HUB_ORIGIN
      : await requiredText(environment, {
          message: "Custom Hub URL",
          initialValue:
            activeOrigin === undefined || activeOrigin === DEFAULT_HUB_ORIGIN
              ? environment.env.PASEO_HUB_URL
              : activeOrigin,
          validate(value) {
            try {
              normalizeHubOrigin(value ?? "");
            } catch {
              return "Enter a valid Hub URL";
            }
            return undefined;
          },
        });
  const normalizedOrigin = normalizeHubOrigin(origin);
  if (environment.credentials.get(normalizedOrigin) !== null) {
    log.success(`Logged in to ${normalizedOrigin}`);
    return normalizedOrigin;
  }
  environment.reporter.progress(`Logging in to ${normalizedOrigin}`);
  const credential = await environment.login.authorize(normalizedOrigin);
  environment.credentials.save({ origin: normalizedOrigin, credential });
  log.success(`Logged in to ${normalizedOrigin}`);
  return normalizedOrigin;
}

async function ensureDaemonConnection(
  origin: string,
  environment: HubGuidedSetupEnvironment,
  confirmed = false,
  permissions: readonly string[] = ["hub.execute"],
): Promise<string> {
  const status = await withHubDaemon(environment.daemon, undefined, async (daemon) =>
    daemon.getHubStatus().then((response) => response.status),
  );
  const connection = resolveHubInitConnection(status, origin);
  if (connection.kind === "connected") {
    if (permissions.includes("hub.execute") && !status.permissions.includes("hub.execute")) {
      throw new HubCommandError(
        "HUB_DAEMON_EXECUTION_NOT_ALLOWED",
        "This daemon is connected to Hub but cannot run Hub automations. Run `paseo hub permissions grant hub.execute`, then run Hub init again.",
      );
    }
    return connection.daemonId;
  }
  if (connection.kind === "pending") {
    return waitForDaemonReady(origin, environment.daemon);
  }
  if (connection.kind === "conflict") {
    throw new HubCommandError(
      "HUB_DAEMON_ALREADY_CONNECTED",
      `This daemon is connected to ${connection.origin}. Disconnect it before running Hub init for ${origin}.`,
    );
  }
  if (
    !confirmed &&
    !(await requiredConfirm(
      environment,
      `Connect this daemon to ${origin} and allow Hub workflows to create and control workspaces and agents?`,
      true,
    ))
  ) {
    throw new HubInitCancelledError("A connected daemon is required to create the bundle.");
  }
  return connectDaemon(origin, environment, permissions);
}

async function connectDaemon(
  origin: string,
  environment: HubGuidedSetupEnvironment,
  permissions: readonly string[] = ["hub.execute"],
): Promise<string> {
  await runHubConnect(
    origin,
    { permissions },
    {
      env: environment.env,
      credentials: environment.credentials,
      hub: environment.hub,
      daemon: environment.daemon,
      reporter: environment.reporter,
    },
  );
  return waitForDaemonReady(origin, environment.daemon);
}

async function waitForDaemonReady(
  origin: string,
  connection: HubDaemonConnection,
): Promise<string> {
  return withSpinner("Waiting for the daemon to connect", async (reporter) =>
    withHubDaemon(connection, undefined, async (daemon) => {
      const deadline = Date.now() + DAEMON_READY_TIMEOUT_MS;
      while (true) {
        const status = (await daemon.getHubStatus()).status;
        const resolution = resolveHubInitConnection(status, origin);
        if (resolution.kind === "connected") return resolution.daemonId;
        if (resolution.kind === "conflict") {
          throw new HubCommandError(
            "HUB_DAEMON_ALREADY_CONNECTED",
            `This daemon connected to ${resolution.origin} while Hub init was waiting for ${origin}.`,
          );
        }
        if (resolution.kind === "connect") {
          throw new HubCommandError(
            "HUB_DAEMON_CONNECTION_LOST",
            "The daemon lost its Hub relationship while Hub init was waiting for it.",
          );
        }
        if (Date.now() >= deadline) {
          throw new HubCommandError(
            "HUB_DAEMON_CONNECTION_TIMEOUT",
            "The daemon did not connect within 60 seconds. Check `paseo hub status`, then run Hub init again.",
          );
        }
        reporter.progress(`Daemon is ${resolution.state}`);
        await delay(DAEMON_READY_POLL_MS);
      }
    }),
  );
}

async function chooseProject(
  origin: string,
  environment: HubGuidedSetupEnvironment,
): Promise<HubProject> {
  const result = await runHubProjects(
    { hub: origin },
    {
      env: environment.env,
      credentials: environment.credentials,
      hub: environment.hub,
      reporter: { progress() {} },
    },
  );
  const resolution = resolveHubInitProjects(result.data.projects);
  if (resolution.kind === "none") {
    throw new HubInitCancelledError(
      `No Hub projects exist yet. Create one at ${new URL("/projects/new", origin).toString()}, then run paseo hub init again.`,
    );
  }
  if (resolution.kind === "selected") {
    return resolution.project;
  }
  const slug = await requiredSelect(environment, {
    message: "Project",
    options: resolution.projects.map((project) => ({
      value: project.slug,
      label: project.name,
      hint: project.slug,
    })),
  });
  const project = resolution.projects.find((candidate) => candidate.slug === slug);
  if (project === undefined) {
    throw new HubCommandError(
      "HUB_PROJECT_SELECTION_INVALID",
      "The selected Hub project is unavailable.",
    );
  }
  return project;
}

async function resolveStarterTriggerConnections(
  resources: HubSetupResources,
  cwd: string,
): Promise<HubStarterTriggerConnection[]> {
  const remote = await readCommandValue("git", ["remote", "get-url", "origin"], cwd);
  const repository = remote === undefined ? undefined : githubRepositoryFromRemote(remote);
  const connections = availableStarterTriggerConnections(resources, repository);
  if (connections.length === 0) {
    throw new HubInitCancelledError(
      "No Hub app connection is ready for this workflow.\nConnect GitHub, Slack, or Discord in Hub → Apps, then run `paseo hub init` again.",
    );
  }
  return connections;
}

function reportStarterTriggerConnections(
  environment: HubGuidedSetupEnvironment,
  connections: readonly HubStarterTriggerConnection[],
): void {
  const details = `${connections.map(({ label }) => label).join("\n")}\n\nOnly configured connections are shown. To add another, open Hub → Apps, then run \`paseo hub init\` again.`;
  if (environment.prompts === undefined) {
    note(details, "Hub app connections ready for this workflow");
    return;
  }
  environment.prompts.message(`Hub app connections ready for this workflow:\n${details}`);
}

async function chooseStarterTriggerConnection(
  environment: HubGuidedSetupEnvironment,
  connections: readonly HubStarterTriggerConnection[],
): Promise<HubStarterTriggerConnection> {
  if (connections.length === 1) {
    const connection = connections[0]!;
    reportMessage(environment, `Using ${connection.label}`);
    return connection;
  }
  const id = await requiredSelect(environment, {
    message: "Trigger connection",
    options: connections.map((connection) => ({ value: connection.id, label: connection.label })),
  });
  const connection = connections.find((candidate) => candidate.id === id);
  if (connection === undefined) {
    throw new HubCommandError(
      "HUB_PROVIDER_CONNECTION_INVALID",
      "The selected Hub app connection is no longer available. Run paseo hub init again.",
    );
  }
  return connection;
}

async function chooseStarterAgentRuntime(
  environment: HubGuidedSetupEnvironment,
  cwd: string,
): Promise<HubStarterAgentRuntime> {
  const providers = await waitForStarterAgentProviders(environment, cwd);
  const provider = await chooseStarterAgentProvider(environment, providers);
  const model = await chooseStarterAgentModel(environment, provider);
  const mode = await chooseStarterAgentMode(environment, provider);
  const runtime = selectedStarterAgentRuntime(provider, model, mode);
  if (runtime === undefined) {
    throw new HubCommandError(
      "HUB_AGENT_RUNTIME_SELECTION_INVALID",
      "The selected starter agent runtime is no longer available. Run paseo hub init again.",
    );
  }
  return runtime;
}

async function waitForStarterAgentProviders(
  environment: HubGuidedSetupEnvironment,
  cwd: string,
): Promise<readonly HubStarterAgentProvider[]> {
  return withSpinner("Discovering agent runtimes", async (reporter) =>
    withHubDaemon(environment.daemon, undefined, async (daemon) => {
      const deadline = Date.now() + PROVIDER_READY_TIMEOUT_MS;
      while (true) {
        const snapshot = await daemon.getProvidersSnapshot({ cwd });
        const state = starterAgentProviderSnapshotState(snapshot.entries);
        if (state.kind === "ready") return state.providers;
        if (state.kind === "unavailable") {
          throw new HubCommandError(
            "HUB_AGENT_RUNTIME_REQUIRED",
            "No usable agent runtime is available from this daemon. Configure an enabled provider with a selectable model, then run paseo hub init again.",
          );
        }
        if (Date.now() >= deadline) {
          throw new HubCommandError(
            "HUB_AGENT_RUNTIME_TIMEOUT",
            "Agent runtime discovery did not finish within 60 seconds. Check the daemon's provider configuration, then run paseo hub init again.",
          );
        }
        reporter.progress("Waiting for agent runtime discovery");
        await delay(DAEMON_READY_POLL_MS);
      }
    }),
  );
}

async function chooseStarterAgentProvider(
  environment: HubGuidedSetupEnvironment,
  providers: readonly HubStarterAgentProvider[],
): Promise<HubStarterAgentProvider> {
  const selected = await requiredSelect(environment, {
    message: "Starter agent provider",
    options: providers.map((provider) => ({
      value: provider.id,
      label: provider.label,
    })),
  });
  const provider = providers.find((candidate) => candidate.id === selected);
  if (provider === undefined) throw invalidStarterAgentSelection();
  return provider;
}

async function chooseStarterAgentModel(
  environment: HubGuidedSetupEnvironment,
  provider: HubStarterAgentProvider,
): Promise<string> {
  const suggested = suggestedStarterAgentChoice(provider.models);
  const selected = await requiredSelect(environment, {
    message: "Starter agent model",
    ...(suggested === undefined ? {} : { initialValue: suggested.id }),
    options: provider.models.map((model) => ({
      value: model.id,
      label: model.label,
      ...(model.suggested ? { hint: "suggested" } : {}),
    })),
  });
  if (!provider.models.some((model) => model.id === selected)) throw invalidStarterAgentSelection();
  return selected;
}

async function chooseStarterAgentMode(
  environment: HubGuidedSetupEnvironment,
  provider: HubStarterAgentProvider,
): Promise<string | undefined> {
  if (provider.modes.length === 0) return undefined;
  const suggested = suggestedStarterAgentChoice(provider.modes);
  const selected = await requiredSelect(environment, {
    message: "Starter agent mode",
    ...(suggested === undefined ? {} : { initialValue: suggested.id }),
    options: provider.modes.map((mode) => ({
      value: mode.id,
      label: mode.label,
      ...(mode.suggested ? { hint: "suggested" } : {}),
    })),
  });
  if (!provider.modes.some((mode) => mode.id === selected)) throw invalidStarterAgentSelection();
  return selected;
}

function invalidStarterAgentSelection(): HubCommandError {
  return new HubCommandError(
    "HUB_AGENT_RUNTIME_SELECTION_INVALID",
    "The selected starter agent runtime is no longer available. Run paseo hub init again.",
  );
}

async function collectProviderIdentity(
  trigger: HubStarterTriggerConnection,
  environment: HubGuidedSetupEnvironment,
): Promise<Readonly<Record<string, string>>> {
  if (trigger.provider === "github") {
    const login = await readGhValue(["api", "user", "--jq", ".login"]);
    return {
      ...trigger.filters,
      user: await requiredText(environment, {
        message: "Your GitHub username (only this user can trigger the bot)",
        initialValue: login,
      }),
    };
  }
  if (trigger.provider === "slack") {
    return {
      ...trigger.filters,
      user: await requiredText(environment, {
        message: "Your Slack member ID (only this user can trigger the bot)",
      }),
    };
  }
  return {
    ...trigger.filters,
    user: await requiredText(environment, {
      message: "Your Discord user ID (only this user can trigger the bot)",
    }),
  };
}

async function loadSetupResources(
  origin: string,
  environment: HubGuidedSetupEnvironment,
): Promise<HubSetupResources> {
  try {
    return await withSpinner("Loading Hub connections", () =>
      environment.hub.listSetupResources(
        origin,
        resolveHubCredential({
          options: { origin },
          env: environment.env,
          credentials: environment.credentials,
          origin,
        }),
      ),
    );
  } catch (error) {
    if (error instanceof HubCommandError && error.code === "HUB_NOT_FOUND") {
      throw new HubCommandError(
        "HUB_UPDATE_REQUIRED",
        "This Hub needs an update before guided setup can use provider IDs. Update Hub and try again.",
      );
    }
    throw error;
  }
}

async function loadDaemonResource(
  origin: string,
  daemonId: string,
  environment: HubGuidedSetupEnvironment,
): Promise<HubConfigurationResources["daemons"][number]> {
  const resources = await environment.hub.listConfigurationResources(
    origin,
    resolveHubCredential({
      options: { origin },
      env: environment.env,
      credentials: environment.credentials,
      origin,
    }),
  );
  const daemon = resources.daemons.find(({ id }) => id === daemonId);
  if (daemon === undefined) {
    throw new HubCommandError(
      "HUB_DAEMON_RESOURCE_MISSING",
      "The connected daemon is not available in this Hub organization. Reconnect it and try again.",
    );
  }
  return daemon;
}

async function writeScaffold(
  cwd: string,
  scaffold: ReturnType<typeof createHubInitScaffold>,
  replaceExisting: boolean,
): Promise<void> {
  const root = path.join(cwd, ".paseo");
  const staging = path.join(cwd, `.paseo-init-${randomUUID()}`);
  const backup = path.join(cwd, `.paseo-backup-${randomUUID()}`);
  let movedExisting = false;
  try {
    await mkdir(path.join(staging, "workflows"), { recursive: true });
    await writeFile(path.join(staging, "hub.yml"), scaffold.hub, { flag: "wx" });
    await writeFile(
      path.join(staging, "workflows", path.basename(scaffold.workflowPath)),
      scaffold.workflow,
      {
        flag: "wx",
      },
    );
    if (replaceExisting) {
      await rename(root, backup);
      movedExisting = true;
    }
    await rename(staging, root);
    if (movedExisting) await rm(backup, { recursive: true, force: true });
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if (movedExisting) {
      await rename(backup, root).catch(() => undefined);
    }
    throw error;
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readGhValue(args: readonly string[]): Promise<string | undefined> {
  return readCommandValue("gh", args);
}

async function readCommandValue(
  command: string,
  args: readonly string[],
  cwd?: string,
): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(command, [...args], { encoding: "utf8", cwd });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function githubRepositoryFromRemote(remote: string): string | undefined {
  const trimmed = remote.trim().replace(/\.git$/u, "");
  const ssh = /^(?:ssh:\/\/)?git@github\.com[:/]([^/]+\/[^/]+)$/u.exec(trimmed);
  if (ssh?.[1] !== undefined) return ssh[1];
  try {
    const url = new URL(trimmed);
    if (url.hostname !== "github.com") return undefined;
    const repository = url.pathname.replace(/^\//u, "");
    return /^[^/]+\/[^/]+$/u.test(repository) ? repository : undefined;
  } catch {
    return undefined;
  }
}

async function withSpinner<T>(
  message: string,
  action: (reporter: HubReporter) => Promise<T>,
): Promise<T> {
  const progress = spinner();
  progress.start(message);
  try {
    const result = await action({ progress: (nextMessage) => progress.message(nextMessage) });
    progress.stop(message);
    return result;
  } catch (error) {
    progress.error(message);
    throw error;
  }
}

async function requiredText(
  environment: HubGuidedSetupEnvironment,
  options: Parameters<typeof text>[0],
): Promise<string> {
  const request = {
    ...options,
    validate(value: string | undefined) {
      const input = value ?? "";
      const customError = options.validate?.(input);
      if (customError !== undefined) return customError;
      return input.trim().length === 0 ? "A value is required" : undefined;
    },
  };
  const answer =
    environment.prompts === undefined
      ? await text(request)
      : await environment.prompts.text(request);
  if (isCancel(answer)) throw new HubInitCancelledError("Hub init cancelled.");
  return answer.trim();
}

async function requiredConfirm(
  environment: HubGuidedSetupEnvironment,
  message: string,
  initialValue: boolean,
): Promise<boolean> {
  const answer =
    environment.prompts === undefined
      ? await confirm({ message, initialValue })
      : await environment.prompts.confirm(message, initialValue);
  if (isCancel(answer)) throw new HubInitCancelledError("Hub init cancelled.");
  return answer;
}

async function requiredSelect<T extends string>(
  environment: HubGuidedSetupEnvironment,
  options: Parameters<typeof select<T>>[0],
): Promise<T> {
  const answer =
    environment.prompts === undefined
      ? await select<T>(options)
      : ((await environment.prompts.select(options as Parameters<typeof select<string>>[0])) as T);
  if (isCancel(answer)) throw new HubInitCancelledError("Hub init cancelled.");
  return answer;
}

function requireInteractiveTerminal(environment: HubGuidedSetupEnvironment): void {
  if (!(environment.isInteractive?.() ?? (process.stdin.isTTY && process.stdout.isTTY))) {
    throw new HubCommandError("HUB_INIT_INTERACTIVE_REQUIRED", "paseo hub init requires a TTY.");
  }
}

function reportMessage(environment: HubGuidedSetupEnvironment, message: string): void {
  if (environment.prompts === undefined) {
    log.message(message);
    return;
  }
  environment.prompts.message(message);
}
