import type { Command } from "commander";
import {
  withOutput,
  type ListResult,
  type OutputSchema,
  type SingleResult,
} from "../../output/index.js";
import { addJsonOption } from "../../utils/command-options.js";
import { resolveHubCredential, resolveHubOrigin } from "./authority.js";
import {
  HubHttpClient,
  type HubInstallResult,
  type HubTriggerInstallationResult,
  type HubTriggerValidationResult,
  type HubValidationResult,
} from "./hub-client/index.js";
import { PrivateHubCredentialStore, type HubCredentialStore } from "./credentials.js";
import { discoverHubBundle, type HubDeployBundle } from "./deploy-bundle.js";
import { discoverHubTriggers, type HubDeployTrigger } from "./deploy-triggers.js";
import { HubCommandError } from "./error.js";
import { processHubReporter, reportHubProgress, type HubReporter } from "./reporter.js";
import { addHubResolutionHelp } from "./help.js";

export interface HubDeployOptions {
  project?: string;
  hub?: string;
  apiKey?: string;
  dryRun?: boolean;
  json?: boolean;
}

export interface HubDeployEnvironment {
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  credentials?: HubCredentialStore;
  hub?: Pick<
    HubHttpClient,
    "installConfiguration" | "validateConfiguration" | "installTrigger" | "validateTrigger"
  >;
  reporter?: HubReporter;
}

export interface HubDeployCommandDependencies {
  env: Readonly<Record<string, string | undefined>>;
  credentials: HubCredentialStore;
  hub: Pick<
    HubHttpClient,
    "installConfiguration" | "validateConfiguration" | "installTrigger" | "validateTrigger"
  >;
  reporter: HubReporter;
  cwd(): string;
}

interface HubDeployResult extends HubInstallResult {
  origin: string;
  workflows: number;
}

interface HubDryRunResult extends HubValidationResult {
  origin: string;
  workflows: number;
}

interface HubTriggerDeployResult extends HubTriggerInstallationResult {
  origin: string;
  path: string;
}

interface HubTriggerDryRunResult extends HubTriggerValidationResult {
  origin: string;
  path: string;
}

const resultSchema: OutputSchema<HubDeployResult> = {
  idField: "versionId",
  columns: [
    { header: "PROJECT", field: "projectSlug" },
    { header: "VERSION", field: "version" },
    { header: "VERSION ID", field: "versionId" },
    { header: "ACTIVE", field: "active" },
    { header: "WORKFLOWS", field: "workflows" },
    { header: "HUB", field: "origin" },
  ],
};

const validationSchema: OutputSchema<HubDryRunResult> = {
  idField: "projectSlug",
  columns: [
    { header: "PROJECT", field: "projectSlug" },
    { header: "VALID", field: "valid" },
    { header: "WORKFLOWS", field: "workflows" },
    { header: "HUB", field: "origin" },
  ],
};

const triggerResultSchema: OutputSchema<HubTriggerDeployResult> = {
  idField: "triggerId",
  columns: [
    { header: "TRIGGER", field: "name" },
    { header: "VERSION", field: "version" },
    { header: "REVISION ID", field: "revisionId" },
    { header: "ACTIVE", field: "active" },
    { header: "PATH", field: "path" },
    { header: "HUB", field: "origin" },
  ],
};

const triggerValidationSchema: OutputSchema<HubTriggerDryRunResult> = {
  idField: "name",
  columns: [
    { header: "TRIGGER", field: "name" },
    { header: "VALID", field: "valid" },
    { header: "PATH", field: "path" },
    { header: "HUB", field: "origin" },
  ],
};

export async function runHubDeploy(
  options: HubDeployOptions,
  environment: HubDeployEnvironment = {
    cwd: process.cwd(),
    env: process.env,
    credentials: new PrivateHubCredentialStore(),
    hub: new HubHttpClient(),
  },
): Promise<
  | SingleResult<HubDeployResult>
  | SingleResult<HubDryRunResult>
  | ListResult<HubTriggerDeployResult>
  | ListResult<HubTriggerDryRunResult>
> {
  if (options.project === undefined) {
    return runHubDeployTriggers(options, await discoverHubTriggers(environment.cwd), environment);
  }
  const deployInput = await discoverHubBundle({
    cwd: environment.cwd,
    project: options.project,
  });
  return runHubDeployBundle(options, deployInput, environment);
}

export async function runHubDeployTriggers(
  options: HubDeployOptions,
  triggers: readonly HubDeployTrigger[],
  environment: HubDeployEnvironment,
): Promise<ListResult<HubTriggerDeployResult> | ListResult<HubTriggerDryRunResult>> {
  const credentials = environment.credentials ?? new PrivateHubCredentialStore(environment.env);
  const resolution = {
    options: { origin: options.hub, apiKey: options.apiKey },
    env: environment.env,
    credentials,
  };
  const origin = resolveHubOrigin(resolution);
  const credential = resolveHubCredential({ ...resolution, origin });
  const action = options.dryRun === true ? "Validating" : "Deploying";
  reportHubProgress(
    environment.reporter ?? processHubReporter,
    options,
    `${action} ${String(triggers.length)} trigger${triggers.length === 1 ? "" : "s"} ${
      options.dryRun === true ? "against" : "to"
    } ${origin}`,
  );
  const hub = environment.hub ?? new HubHttpClient();
  if (options.dryRun === true) {
    const data = await Promise.all(
      triggers.map(async (trigger) => ({
        ...(await hub.validateTrigger(origin, credential, trigger.yaml)),
        origin,
        path: trigger.path,
      })),
    );
    return { type: "list", data, schema: triggerValidationSchema };
  }
  await Promise.all(
    triggers.map((trigger) => hub.validateTrigger(origin, credential, trigger.yaml)),
  );
  const data: HubTriggerDeployResult[] = [];
  for (const trigger of triggers) {
    try {
      data.push({
        ...(await hub.installTrigger(origin, credential, trigger.yaml)),
        origin,
        path: trigger.path,
      });
    } catch (error) {
      if (data.length === 0) throw error;
      throw new HubCommandError(
        "HUB_TRIGGER_DEPLOY_PARTIAL",
        `Could not deploy ${trigger.path} after ${String(data.length)} trigger${data.length === 1 ? "" : "s"} had been installed.`,
        `${errorMessage(error)}\nInstalled before the failure:\n${data.map(({ path: installedPath }) => `- ${installedPath}`).join("\n")}`,
      );
    }
  }
  return { type: "list", data, schema: triggerResultSchema };
}

function errorMessage(error: unknown): string {
  if (error instanceof HubCommandError) {
    return error.details === undefined ? error.message : `${error.message}\n${error.details}`;
  }
  return error instanceof Error ? error.message : String(error);
}

export async function runHubDeployBundle(
  options: HubDeployOptions,
  deployInput: HubDeployBundle,
  environment: HubDeployEnvironment,
): Promise<SingleResult<HubDeployResult> | SingleResult<HubDryRunResult>> {
  const credentials = environment.credentials ?? new PrivateHubCredentialStore(environment.env);
  const resolution = {
    options: { origin: options.hub, apiKey: options.apiKey },
    env: environment.env,
    credentials,
  };
  const origin = resolveHubOrigin(resolution);
  const action = options.dryRun === true ? "Validating" : "Deploying";
  reportHubProgress(
    environment.reporter ?? processHubReporter,
    options,
    `${action} ${deployInput.projectSlug} ${options.dryRun === true ? "against" : "to"} ${origin}`,
  );
  const credential = resolveHubCredential({ ...resolution, origin });
  const request = {
    origin,
    apiKey: credential,
    ...deployInput,
  };
  if (options.dryRun === true) {
    const validated = await (environment.hub ?? new HubHttpClient()).validateConfiguration(request);
    return {
      type: "single",
      data: { ...validated, workflows: deployInput.workflowCount, origin },
      schema: validationSchema,
    };
  }
  const deployed = await (environment.hub ?? new HubHttpClient()).installConfiguration(request);

  return {
    type: "single",
    data: { ...deployed, workflows: deployInput.workflowCount, origin },
    schema: resultSchema,
  };
}

export function addHubDeployCommand(
  hub: Command,
  dependencies: HubDeployCommandDependencies,
): void {
  addJsonOption(
    addHubResolutionHelp(
      hub
        .command("deploy")
        .description("Deploy .paseo organization triggers or a legacy project bundle")
        .option("-p, --project <slug>", "Deploy a legacy bundle to this project slug")
        .option("--hub <origin>", "Paseo Hub origin")
        .option("--api-key <secret>", "Organization API key")
        .option("--dry-run", "Validate without installing or activating"),
    ),
  ).action(
    withOutput<
      HubDeployResult | HubDryRunResult | HubTriggerDeployResult | HubTriggerDryRunResult,
      unknown[]
    >(async (...args) => {
      const options = args.at(-2) as HubDeployOptions;
      return runHubDeploy(options, {
        cwd: dependencies.cwd(),
        env: dependencies.env,
        credentials: dependencies.credentials,
        hub: dependencies.hub,
        reporter: dependencies.reporter,
      });
    }),
  );
}
