import type { Command } from "commander";
import { withOutput, type OutputSchema, type SingleResult } from "../../output/index.js";
import { addJsonOption } from "../../utils/command-options.js";
import { resolveHubAuthority } from "./authority.js";
import { HubHttpClient, type HubInstallResult, type HubValidationResult } from "./client.js";
import { PrivateHubCredentialStore, type HubCredentialStore } from "./credentials.js";
import { resolveHubDeployInput } from "./deploy-input.js";

export interface HubDeployOptions {
  file?: string;
  project?: string;
  hub?: string;
  apiKey?: string;
  dryRun?: boolean;
}

interface HubDeployEnvironment {
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  credentials?: HubCredentialStore;
  hub?: Pick<HubHttpClient, "installConfiguration" | "validateConfiguration">;
}

const resultSchema: OutputSchema<HubInstallResult> = {
  idField: "versionId",
  columns: [
    { header: "PROJECT", field: "projectSlug" },
    { header: "VERSION", field: "version" },
    { header: "VERSION ID", field: "versionId" },
    { header: "ACTIVE", field: "active" },
  ],
};

const validationSchema: OutputSchema<HubValidationResult> = {
  idField: "projectSlug",
  columns: [
    { header: "PROJECT", field: "projectSlug" },
    { header: "VALID", field: "valid" },
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
): Promise<SingleResult<HubInstallResult> | SingleResult<HubValidationResult>> {
  const authority = resolveHubAuthority({
    options: { origin: options.hub, apiKey: options.apiKey },
    env: environment.env,
    credentials: environment.credentials ?? new PrivateHubCredentialStore(environment.env),
  });
  const deployInput = await resolveHubDeployInput({
    cwd: environment.cwd,
    ...(options.file === undefined ? {} : { file: options.file }),
    ...(options.project === undefined ? {} : { project: options.project }),
  });
  const request = {
    origin: authority.origin,
    apiKey: authority.credential,
    ...deployInput,
  };
  if (options.dryRun === true) {
    const validated = await (environment.hub ?? new HubHttpClient()).validateConfiguration(request);
    return { type: "single", data: validated, schema: validationSchema };
  }
  const deployed = await (environment.hub ?? new HubHttpClient()).installConfiguration(request);

  return { type: "single", data: deployed, schema: resultSchema };
}

export function addHubDeployCommand(hub: Command): void {
  addJsonOption(
    hub
      .command("deploy")
      .description("Install and activate a Hub configuration")
      .argument("[file]", "Hub configuration YAML", ".paseo/hub.yml")
      .option("-p, --project <slug>", "Target project slug")
      .option("--hub <origin>", "Paseo Hub origin")
      .option("--api-key <secret>", "Organization API key")
      .option("--dry-run", "Validate without installing or activating"),
  ).action(
    withOutput<HubInstallResult | HubValidationResult, unknown[]>(async (...args) => {
      const file = args[0] as string;
      const options = args.at(-2) as HubDeployOptions;
      return runHubDeploy({ ...options, file });
    }),
  );
}
