import type { Command } from "commander";
import { withOutput, type OutputSchema, type SingleResult } from "../../output/index.js";
import { addJsonOption } from "../../utils/command-options.js";
import { resolveHubCredential, resolveHubOrigin } from "./authority.js";
import {
  HubHttpClient,
  type HubInstallResult,
  type HubValidationResult,
} from "./hub-client/index.js";
import { PrivateHubCredentialStore, type HubCredentialStore } from "./credentials.js";
import { discoverHubBundle } from "./deploy-bundle.js";
import { processHubReporter, reportHubProgress, type HubReporter } from "./reporter.js";
import { addHubResolutionHelp } from "./help.js";

export interface HubDeployOptions {
  project?: string;
  hub?: string;
  apiKey?: string;
  dryRun?: boolean;
  json?: boolean;
}

interface HubDeployEnvironment {
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  credentials?: HubCredentialStore;
  hub?: Pick<HubHttpClient, "installConfiguration" | "validateConfiguration">;
  reporter?: HubReporter;
}

export interface HubDeployCommandDependencies {
  env: Readonly<Record<string, string | undefined>>;
  credentials: HubCredentialStore;
  hub: Pick<HubHttpClient, "installConfiguration" | "validateConfiguration">;
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

export async function runHubDeploy(
  options: HubDeployOptions,
  environment: HubDeployEnvironment = {
    cwd: process.cwd(),
    env: process.env,
    credentials: new PrivateHubCredentialStore(),
    hub: new HubHttpClient(),
  },
): Promise<SingleResult<HubDeployResult> | SingleResult<HubDryRunResult>> {
  const credentials = environment.credentials ?? new PrivateHubCredentialStore(environment.env);
  const resolution = {
    options: { origin: options.hub, apiKey: options.apiKey },
    env: environment.env,
    credentials,
  };
  const origin = resolveHubOrigin(resolution);
  const deployInput = await discoverHubBundle({
    cwd: environment.cwd,
    ...(options.project === undefined ? {} : { project: options.project }),
  });
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
        .description("Discover, validate, and activate the canonical .paseo Hub bundle")
        .option("-p, --project <slug>", "Target project slug")
        .option("--hub <origin>", "Paseo Hub origin")
        .option("--api-key <secret>", "Organization API key")
        .option("--dry-run", "Validate without installing or activating"),
    ),
  ).action(
    withOutput<HubDeployResult | HubDryRunResult, unknown[]>(async (...args) => {
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
