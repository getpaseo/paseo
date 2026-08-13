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
import type { HubConfigurationResources, HubHttpClient, HubProject } from "./hub-client/index.js";
import {
  createHubInitBundle,
  createHubInitScaffold,
  planHubInitOpening,
  resolveHubInitConnection,
  resolveHubInitProjects,
  type HubInitProvider,
} from "./init-plan.js";
import type { CliLoginFlow } from "./login-flow.js";
import { runHubLogin } from "./login.js";
import { runHubConnect } from "./connect.js";
import { runHubDeployBundle } from "./deploy.js";
import { runHubProjects } from "./projects.js";
import type { HubReporter } from "./reporter.js";
import { normalizeHubOrigin } from "./origin.js";

const execFileAsync = promisify(execFile);
const DAEMON_READY_TIMEOUT_MS = 60_000;
const DAEMON_READY_POLL_MS = 250;

interface HubInitEnvironment {
  env: Readonly<Record<string, string | undefined>>;
  credentials: HubCredentialStore;
  hub: HubHttpClient;
  login: Pick<CliLoginFlow, "authorize">;
  daemon: HubDaemonConnection;
  reporter: HubReporter;
  cwd(): string;
}

class HubInitCancelledError extends Error {}

function initErrorMessage(error: unknown): string {
  if (error instanceof HubCommandError && error.details) {
    return `${error.message}\n${error.details}`;
  }
  return error instanceof Error ? error.message : String(error);
}

export function addHubInitCommand(parent: Command, environment: HubInitEnvironment): void {
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

export async function runHubInit(environment: HubInitEnvironment): Promise<void> {
  requireInteractiveTerminal();
  intro("Set up Paseo Hub");

  const cwd = environment.cwd();
  const activeLogin = environment.credentials.active();
  const opening = planHubInitOpening({
    loggedIn: activeLogin !== null,
    paseoDirectoryExists: await pathExists(path.join(cwd, ".paseo")),
  });
  if (
    opening.replaceExisting &&
    !(await requiredConfirm("Replace the existing .paseo/ Hub bundle?", false))
  ) {
    throw new HubInitCancelledError("Existing .paseo/ bundle left unchanged.");
  }

  const origin = await ensureLogin(activeLogin?.origin, environment);
  const daemonId = await ensureDaemonConnection(origin, environment);
  const project = await chooseProject(origin, environment);
  const resources = await loadConfigurationResources(origin, environment);
  const daemon = resources.daemons.find(({ id }) => id === daemonId);
  if (daemon === undefined) {
    throw new HubCommandError(
      "HUB_DAEMON_RESOURCE_MISSING",
      "The connected daemon is not available in this Hub organization. Reconnect it and try again.",
    );
  }
  log.success(`Connected as ${daemon.slug}`);
  const provider = await chooseProvider();
  const providerFilters = await collectProviderFilters(provider, resources, cwd);
  const scaffold = createHubInitScaffold({
    cwd,
    daemonSlug: daemon.slug,
    provider,
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

  const deploy = await requiredConfirm("Deploy now?", true);
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
    log.message(`Skipped deployment. Run: paseo hub deploy -p ${project.slug}`);
  }

  const activityUrl = new URL(`/projects/${project.slug}/activity`, origin).toString();
  note(`${scaffold.testAction}\nWatch it at ${activityUrl}`, "Test your workflow");
  outro(deploy ? "Hub is ready" : "Hub bundle is ready");
}

async function ensureLogin(
  activeOrigin: string | undefined,
  environment: HubInitEnvironment,
): Promise<string> {
  const endpoint = await requiredSelect({
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
      : await requiredText({
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
  await runHubLogin(
    normalizedOrigin,
    {},
    {
      env: environment.env,
      credentials: environment.credentials,
      flow: environment.login,
      reporter: environment.reporter,
    },
  );
  log.success(`Logged in to ${normalizedOrigin}`);
  return normalizedOrigin;
}

async function ensureDaemonConnection(
  origin: string,
  environment: HubInitEnvironment,
): Promise<string> {
  const status = await withHubDaemon(environment.daemon, undefined, async (daemon) =>
    daemon.getHubStatus().then((response) => response.status),
  );
  const connection = resolveHubInitConnection(status, origin);
  if (connection.kind === "connected") {
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
  if (!(await requiredConfirm(`Connect this daemon to ${origin}?`, true))) {
    throw new HubInitCancelledError("A connected daemon is required to create the bundle.");
  }
  await runHubConnect(
    origin,
    {},
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

async function chooseProject(origin: string, environment: HubInitEnvironment): Promise<HubProject> {
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
  const slug = await requiredSelect({
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

async function chooseProvider(): Promise<HubInitProvider> {
  return requiredSelect({
    message: "Trigger provider",
    options: [
      { value: "github", label: "GitHub", hint: "issue or pull request comment" },
      { value: "slack", label: "Slack", hint: "channel mention" },
      { value: "discord", label: "Discord", hint: "channel mention" },
    ],
  });
}

async function collectProviderFilters(
  provider: HubInitProvider,
  resources: HubConfigurationResources,
  cwd: string,
): Promise<Readonly<Record<string, string>>> {
  if (provider === "github") {
    const [login, originRemote] = await Promise.all([
      readGhValue(["api", "user", "--jq", ".login"]),
      readCommandValue("git", ["remote", "get-url", "origin"], cwd),
    ]);
    const repo = originRemote === undefined ? undefined : githubRepositoryFromRemote(originRemote);
    if (repo === undefined) {
      throw new HubCommandError(
        "HUB_GITHUB_REPOSITORY_UNDETECTED",
        "Could not detect a GitHub repository from the origin remote.",
      );
    }
    if (!resources.github.some(({ repositories }) => repositories.includes(repo))) {
      const connected = resources.github.flatMap(({ repositories }) => repositories);
      throw new HubCommandError(
        "HUB_GITHUB_REPOSITORY_NOT_CONNECTED",
        `${repo} is not connected to this Hub organization. Connected repositories: ${connected.join(", ") || "none"}.`,
      );
    }
    return {
      user: await requiredText({
        message: "Your GitHub username (only this user can trigger the bot)",
        initialValue: login,
      }),
      repo,
    };
  }
  if (provider === "slack") {
    return {
      workspace: await chooseConnection(
        "Slack workspace",
        resources.slack.map(({ slug, teamName }) => ({ slug, label: teamName })),
      ),
      user: await requiredText({
        message: "Your Slack username (only this user can trigger the bot)",
      }),
    };
  }
  return {
    guild: await chooseConnection(
      "Discord server",
      resources.discord.map(({ slug, guildName }) => ({ slug, label: guildName })),
    ),
    user: await requiredText({
      message: "Your Discord username (only this user can trigger the bot)",
    }),
  };
}

async function loadConfigurationResources(
  origin: string,
  environment: HubInitEnvironment,
): Promise<HubConfigurationResources> {
  try {
    return await withSpinner("Loading Hub connections", () =>
      environment.hub.listConfigurationResources(
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
        "This Hub does not support guided setup. Update the Hub and try again.",
      );
    }
    throw error;
  }
}

async function chooseConnection(
  message: string,
  connections: readonly { slug: string; label: string }[],
): Promise<string> {
  if (connections.length === 0) {
    throw new HubCommandError(
      "HUB_PROVIDER_CONNECTION_REQUIRED",
      `No ${message.toLowerCase()} is connected in this Hub organization. Connect one and try again.`,
    );
  }
  if (connections.length === 1) return connections[0]!.slug;
  return requiredSelect({
    message,
    options: connections.map(({ slug, label }) => ({ value: slug, label })),
  });
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

async function requiredText(options: Parameters<typeof text>[0]): Promise<string> {
  const answer = await text({
    ...options,
    validate(value) {
      const input = value ?? "";
      const customError = options.validate?.(input);
      if (customError !== undefined) return customError;
      return input.trim().length === 0 ? "A value is required" : undefined;
    },
  });
  if (isCancel(answer)) throw new HubInitCancelledError("Hub init cancelled.");
  return answer.trim();
}

async function requiredConfirm(message: string, initialValue: boolean): Promise<boolean> {
  const answer = await confirm({ message, initialValue });
  if (isCancel(answer)) throw new HubInitCancelledError("Hub init cancelled.");
  return answer;
}

async function requiredSelect<T extends string>(
  options: Parameters<typeof select<T>>[0],
): Promise<T> {
  const answer = await select<T>(options);
  if (isCancel(answer)) throw new HubInitCancelledError("Hub init cancelled.");
  return answer;
}

function requireInteractiveTerminal(): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new HubCommandError("HUB_INIT_INTERACTIVE_REQUIRED", "paseo hub init requires a TTY.");
  }
}
