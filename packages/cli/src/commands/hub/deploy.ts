import type { Command } from "commander";
import { withOutput, type OutputSchema, type SingleResult } from "../../output/index.js";
import { addJsonOption } from "../../utils/command-options.js";
import { installHubConfiguration, type HubInstallResult } from "./client.js";
import { resolveHubDeployInput } from "./deploy-input.js";
import { HubDeployError } from "./error.js";

export interface HubDeployOptions {
  file?: string;
  project?: string;
  hub?: string;
  apiKey?: string;
}

interface HubDeployEnvironment {
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
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

export async function runHubDeploy(
  options: HubDeployOptions,
  environment: HubDeployEnvironment = { cwd: process.cwd(), env: process.env },
): Promise<SingleResult<HubInstallResult>> {
  const origin = options.hub ?? environment.env.PASEO_HUB_URL;
  const apiKey = options.apiKey ?? environment.env.PASEO_HUB_API_KEY;
  if (!origin) {
    throw new HubDeployError(
      "HUB_ORIGIN_REQUIRED",
      "Hub origin is required. Pass --hub <origin> or set PASEO_HUB_URL.",
    );
  }
  if (!apiKey) {
    throw new HubDeployError(
      "HUB_API_KEY_REQUIRED",
      "Hub API key is required. Pass --api-key <secret> or set PASEO_HUB_API_KEY.",
    );
  }

  const normalizedOrigin = parseHubOrigin(origin);
  const deployInput = await resolveHubDeployInput({
    cwd: environment.cwd,
    ...(options.file === undefined ? {} : { file: options.file }),
    ...(options.project === undefined ? {} : { project: options.project }),
  });
  const deployed = await installHubConfiguration({
    origin: normalizedOrigin,
    apiKey,
    ...deployInput,
  });

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
      .option("--api-key <secret>", "Organization API key"),
  ).action(
    withOutput(async (...args) => {
      const file = args[0] as string;
      const options = args.at(-2) as HubDeployOptions;
      return runHubDeploy({ ...options, file });
    }),
  );
}

function parseHubOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidHubOrigin();
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw invalidHubOrigin();
  }
  return url.origin;
}

function invalidHubOrigin(): HubDeployError {
  return new HubDeployError(
    "HUB_INVALID_ORIGIN",
    "Hub URL must be an HTTP or HTTPS origin without credentials, path, query, or hash.",
  );
}
