import type { Command } from "commander";
import { withOutput, type ListResult, type OutputSchema } from "../../output/index.js";
import { addJsonOption } from "../../utils/command-options.js";
import { resolveHubAuthority } from "./authority.js";
import type { HubHttpClient, HubProject } from "./client.js";
import type { HubCredentialStore } from "./credentials.js";

const schema: OutputSchema<HubProject> = {
  idField: "id",
  columns: [
    { header: "SLUG", field: "slug" },
    { header: "NAME", field: "name" },
    { header: "ID", field: "id" },
  ],
};

export interface HubProjectsOptions {
  hub?: string;
  apiKey?: string;
}

interface HubProjectsDependencies {
  env: Readonly<Record<string, string | undefined>>;
  credentials: HubCredentialStore;
  hub: Pick<HubHttpClient, "listProjects">;
}

export async function runHubProjects(
  options: HubProjectsOptions,
  dependencies: HubProjectsDependencies,
): Promise<ListResult<HubProject>> {
  const authority = resolveHubAuthority({
    options: { origin: options.hub, apiKey: options.apiKey },
    env: dependencies.env,
    credentials: dependencies.credentials,
  });
  const projects = await dependencies.hub.listProjects(authority.origin, authority.credential);
  return { type: "list", data: projects, schema };
}

export function addHubProjectsCommand(
  parent: Command,
  dependencies: HubProjectsDependencies,
): void {
  addJsonOption(
    parent
      .command("projects")
      .description("List projects for the authenticated Hub organization")
      .option("--hub <origin>", "Paseo Hub origin")
      .option("--api-key <secret>", "Organization API key"),
  ).action(
    withOutput(async (...args) => {
      const options = args.at(-2) as HubProjectsOptions;
      return runHubProjects(options, dependencies);
    }),
  );
}
