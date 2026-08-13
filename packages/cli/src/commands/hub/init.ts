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
import { lstat, mkdir, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Command } from "commander";
import { DEFAULT_HUB_ORIGIN } from "./authority.js";
import type { HubCredentialStore } from "./credentials.js";
import type { HubDaemonConnection } from "./daemon-client.js";
import { withHubDaemon } from "./daemon-client.js";
import { HubCommandError } from "./error.js";
import type { HubHttpClient, HubProject } from "./hub-client/index.js";
import {
  createHubInitScaffold,
  planHubInitOpening,
  resolveHubInitConnection,
  resolveHubInitProjects,
  type HubInitProvider,
} from "./init-plan.js";
import type { CliLoginFlow } from "./login-flow.js";
import { runHubLogin } from "./login.js";
import { runHubConnect } from "./connect.js";
import { runHubDeploy } from "./deploy.js";
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
        cancel(error instanceof Error ? error.message : String(error));
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
    cwd,
  });
  if (opening.kind === "refuse-existing") {
    throw new HubInitCancelledError(
      `${opening.path} already exists. Hub init will not change an existing bundle.`,
    );
  }

  const origin = await ensureLogin(activeLogin?.origin, environment);
  await ensureDaemonConnection(origin, environment);
  const daemonSlug = await requiredText({
    message: "Daemon slug shown in Hub",
    placeholder: "my-daemon",
  });
  const project = await chooseProject(origin, environment);
  const provider = await chooseProvider();
  const providerFilters = await collectProviderFilters(provider);
  const scaffold = createHubInitScaffold({
    cwd,
    daemonSlug,
    provider,
    providerFilters,
  });

  await writeScaffold(cwd, scaffold);
  log.success(`Created .paseo/hub.yml and ${scaffold.workflowPath}`);

  await withSpinner("Validating bundle", async (reporter) => {
    await runHubDeploy(
      { project: project.slug, hub: origin, dryRun: true },
      {
        cwd,
        env: environment.env,
        credentials: environment.credentials,
        hub: environment.hub,
        reporter,
      },
    );
  });
  log.success("Dry run passed");

  const deploy = await requiredConfirm("Deploy now?", true);
  if (deploy) {
    await withSpinner("Deploying bundle", async (reporter) => {
      await runHubDeploy(
        { project: project.slug, hub: origin },
        {
          cwd,
          env: environment.env,
          credentials: environment.credentials,
          hub: environment.hub,
          reporter,
        },
      );
    });
    log.success(`Deployed to ${project.name}`);
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
  if (activeOrigin !== undefined) {
    log.success(`Logged in to ${activeOrigin}`);
    return activeOrigin;
  }
  const origin = await requiredText({
    message: "Hub URL",
    initialValue: DEFAULT_HUB_ORIGIN,
    validate(value) {
      try {
        normalizeHubOrigin(value ?? "");
      } catch {
        return "Enter a valid Hub URL";
      }
      return undefined;
    },
  });
  await runHubLogin(
    origin,
    {},
    {
      env: environment.env,
      credentials: environment.credentials,
      flow: environment.login,
      reporter: environment.reporter,
    },
  );
  log.success(`Logged in to ${origin}`);
  return environment.credentials.active()?.origin ?? origin;
}

async function ensureDaemonConnection(
  origin: string,
  environment: HubInitEnvironment,
): Promise<void> {
  const status = await withHubDaemon(environment.daemon, undefined, async (daemon) =>
    daemon.getHubStatus().then((response) => response.status),
  );
  const connection = resolveHubInitConnection(status, origin);
  if (connection.kind === "connected") {
    log.success(`Daemon ${connection.daemonId} is connected to ${origin}`);
    return;
  }
  if (connection.kind === "pending") {
    await waitForDaemonReady(origin, environment.daemon);
    return;
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
  await waitForDaemonReady(origin, environment.daemon);
}

async function waitForDaemonReady(origin: string, connection: HubDaemonConnection): Promise<void> {
  const daemonId = await withSpinner("Waiting for the daemon to connect", async (reporter) =>
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
  log.success(`Daemon ${daemonId} is connected to ${origin}`);
}

async function chooseProject(origin: string, environment: HubInitEnvironment): Promise<HubProject> {
  const result = await withSpinner("Loading Hub projects", (reporter) =>
    runHubProjects(
      { hub: origin },
      {
        env: environment.env,
        credentials: environment.credentials,
        hub: environment.hub,
        reporter,
      },
    ),
  );
  const resolution = resolveHubInitProjects(result.data.projects);
  if (resolution.kind === "none") {
    throw new HubInitCancelledError(
      `No Hub projects exist yet. Create one at ${new URL("/projects/new", origin).toString()}, then run paseo hub init again.`,
    );
  }
  if (resolution.kind === "selected") {
    log.success(`Using the only project: ${resolution.project.name} (${resolution.project.slug})`);
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
): Promise<Readonly<Record<string, string>>> {
  if (provider === "github") {
    const [login, repo] = await Promise.all([
      readGhValue(["api", "user", "--jq", ".login"]),
      readGhValue(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]),
    ]);
    return {
      user: await requiredText({ message: "Allowed GitHub login", initialValue: login }),
      repo: await requiredText({ message: "GitHub repository", initialValue: repo }),
    };
  }
  if (provider === "slack") {
    return {
      workspace: await requiredText({ message: "Slack workspace ID", placeholder: "T01234567" }),
      channel: await requiredText({ message: "Slack channel ID", placeholder: "C01234567" }),
      user: await requiredText({ message: "Allowed Slack user ID", placeholder: "U01234567" }),
    };
  }
  return {
    guild: await requiredText({ message: "Discord guild ID", placeholder: "123456789012345678" }),
    channel: await requiredText({
      message: "Discord channel ID",
      placeholder: "234567890123456789",
    }),
    user: await requiredText({
      message: "Allowed Discord user ID",
      placeholder: "345678901234567890",
    }),
  };
}

async function writeScaffold(
  cwd: string,
  scaffold: ReturnType<typeof createHubInitScaffold>,
): Promise<void> {
  const root = path.join(cwd, ".paseo");
  try {
    await mkdir(root);
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      throw new HubInitCancelledError(
        `${root} now exists. Hub init will not change an existing bundle.`,
      );
    }
    throw error;
  }
  try {
    await mkdir(path.join(root, "workflows"));
    await writeFile(path.join(root, "hub.yml"), scaffold.hub, { flag: "wx" });
    await writeFile(path.join(cwd, scaffold.workflowPath), scaffold.workflow, { flag: "wx" });
  } catch (error) {
    await rm(path.join(cwd, scaffold.workflowPath), { force: true });
    await rm(path.join(root, "hub.yml"), { force: true });
    await rmdir(path.join(root, "workflows")).catch(() => undefined);
    await rmdir(root).catch(() => undefined);
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
  try {
    const { stdout } = await execFileAsync("gh", [...args], { encoding: "utf8" });
    return stdout.trim() || undefined;
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
