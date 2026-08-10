import type { Command } from "commander";
import { render, withOutput, type OutputSchema, type SingleResult } from "../../output/index.js";
import { addJsonOption } from "../../utils/command-options.js";
import { resolveHubCredential, resolveHubOrigin } from "./authority.js";
import type { HubHttpClient, HubProject } from "./client.js";
import type { HubCredentialStore } from "./credentials.js";
import { reportHubProgress, type HubReporter } from "./reporter.js";
import { addHubResolutionHelp } from "./help.js";

interface HubProjectRow extends HubProject {
  origin: string;
}

interface HubProjectsResult {
  origin: string;
  projects: HubProject[];
}

const projectSchema: OutputSchema<HubProjectRow> = {
  idField: "id",
  columns: [
    { header: "SLUG", field: "slug" },
    { header: "NAME", field: "name" },
    { header: "ID", field: "id" },
    { header: "HUB", field: "origin" },
  ],
};

const schema: OutputSchema<HubProjectsResult> = {
  idField: "origin",
  columns: [
    { header: "HUB", field: "origin" },
    { header: "PROJECTS", field: (result) => result.projects.length },
  ],
  renderHuman(result, options) {
    const results = result.type === "single" ? [result.data] : result.data;
    const data = results.flatMap((entry) =>
      entry.projects.map((project) => ({ ...project, origin: entry.origin })),
    );
    return render<HubProjectRow>({ type: "list", data, schema: projectSchema }, options);
  },
};

export interface HubProjectsOptions {
  hub?: string;
  apiKey?: string;
  json?: boolean;
}

interface HubProjectsDependencies {
  env: Readonly<Record<string, string | undefined>>;
  credentials: HubCredentialStore;
  hub: Pick<HubHttpClient, "listProjects">;
  reporter: HubReporter;
}

export async function runHubProjects(
  options: HubProjectsOptions,
  dependencies: HubProjectsDependencies,
): Promise<SingleResult<HubProjectsResult>> {
  const resolution = {
    options: { origin: options.hub, apiKey: options.apiKey },
    env: dependencies.env,
    credentials: dependencies.credentials,
  };
  const origin = resolveHubOrigin(resolution);
  reportHubProgress(dependencies.reporter, options, `Listing projects from ${origin}`);
  const credential = resolveHubCredential({ ...resolution, origin });
  const projects = await dependencies.hub.listProjects(origin, credential);
  return { type: "single", data: { origin, projects }, schema };
}

export function addHubProjectsCommand(
  parent: Command,
  dependencies: HubProjectsDependencies,
): void {
  addJsonOption(
    addHubResolutionHelp(
      parent
        .command("projects")
        .description("List projects for the authenticated Hub organization")
        .option("--hub <origin>", "Paseo Hub origin")
        .option("--api-key <secret>", "Organization API key"),
    ),
  ).action(
    withOutput(async (...args) => {
      const options = args.at(-2) as HubProjectsOptions;
      return runHubProjects(options, dependencies);
    }),
  );
}
