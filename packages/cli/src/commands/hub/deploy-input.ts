import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { HubDeployError } from "./error.js";

const DEFAULT_CONFIGURATION_PATH = ".paseo/hub.yml";
const PROJECT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export interface HubDeployInput {
  projectSlug: string;
  yaml: string;
}

export async function resolveHubDeployInput(input: {
  cwd: string;
  file?: string;
  project?: string;
}): Promise<HubDeployInput> {
  const file = input.file ?? DEFAULT_CONFIGURATION_PATH;
  let yaml: string;
  try {
    yaml = await readFile(path.resolve(input.cwd, file), "utf8");
  } catch {
    throw new HubDeployError(
      "HUB_CONFIGURATION_UNREADABLE",
      `Could not read Hub configuration at ${file}. Pass an existing YAML file.`,
    );
  }
  const projectSlug = input.project ?? projectFromYaml(yaml);

  if (projectSlug === undefined) {
    throw new HubDeployError(
      "HUB_PROJECT_REQUIRED",
      "Project is required. Pass --project <slug> or add top-level project to the YAML.",
    );
  }
  if (!PROJECT_SLUG_PATTERN.test(projectSlug)) {
    throw new HubDeployError(
      "HUB_INVALID_PROJECT",
      "Project must be a bare slug such as my-project.",
    );
  }

  return { projectSlug, yaml };
}

function projectFromYaml(yaml: string): string | undefined {
  let configuration: unknown;
  try {
    configuration = YAML.parse(yaml);
  } catch {
    throw new HubDeployError("HUB_INVALID_CONFIGURATION", "Hub configuration is not valid YAML.");
  }
  if (typeof configuration !== "object" || configuration === null || Array.isArray(configuration)) {
    throw new HubDeployError(
      "HUB_INVALID_CONFIGURATION",
      "Hub configuration must be a YAML mapping.",
    );
  }

  const project: unknown = Reflect.get(configuration, "project");
  if (project === undefined) return undefined;
  if (typeof project !== "string") {
    throw new HubDeployError(
      "HUB_INVALID_PROJECT",
      "Top-level project must be a bare project slug.",
    );
  }
  return project;
}
