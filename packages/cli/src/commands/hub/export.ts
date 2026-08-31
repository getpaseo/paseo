import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import { withOutput, type OutputSchema, type SingleResult } from "../../output/index.js";
import { addJsonOption } from "../../utils/command-options.js";
import { resolveHubCredential, resolveHubOrigin } from "./authority.js";
import type { HubCredentialStore } from "./credentials.js";
import { HubCommandError } from "./error.js";
import { addHubResolutionHelp } from "./help.js";
import type { HubHttpClient } from "./hub-client/index.js";
import { reportHubProgress, type HubReporter } from "./reporter.js";

interface HubExportResult {
  origin: string;
  directory: string;
  exported: number;
  unchanged: number;
}

const schema: OutputSchema<HubExportResult> = {
  idField: "directory",
  columns: [
    { header: "DIRECTORY", field: "directory" },
    { header: "EXPORTED", field: "exported" },
    { header: "UNCHANGED", field: "unchanged" },
    { header: "HUB", field: "origin" },
  ],
};

export interface HubExportOptions {
  hub?: string;
  apiKey?: string;
  force?: boolean;
  json?: boolean;
}

interface HubExportDependencies {
  env: Readonly<Record<string, string | undefined>>;
  credentials: HubCredentialStore;
  hub: Pick<HubHttpClient, "listTriggers">;
  reporter: HubReporter;
  cwd(): string;
}

export async function runHubExport(
  directoryInput: string | undefined,
  options: HubExportOptions,
  dependencies: HubExportDependencies,
): Promise<SingleResult<HubExportResult>> {
  const resolution = {
    options: { origin: options.hub, apiKey: options.apiKey },
    env: dependencies.env,
    credentials: dependencies.credentials,
  };
  const origin = resolveHubOrigin(resolution);
  const credential = resolveHubCredential({ ...resolution, origin });
  const directory = path.resolve(dependencies.cwd(), directoryInput ?? ".paseo/triggers");
  reportHubProgress(dependencies.reporter, options, `Exporting triggers from ${origin}`);
  const triggers = await dependencies.hub.listTriggers(origin, credential);
  await mkdir(directory, { recursive: true });

  const files = await Promise.all(
    triggers.map(async (trigger) => {
      const destination = path.join(directory, `${trigger.name}.yml`);
      return { destination, trigger, existing: await readOptionalFile(destination) };
    }),
  );
  const conflict = files.find(
    ({ existing, trigger }) =>
      existing !== undefined && existing !== trigger.yaml && options.force !== true,
  );
  if (conflict !== undefined) {
    throw new HubCommandError(
      "HUB_EXPORT_CONFLICT",
      `${conflict.destination} already exists with different contents. Pass --force to replace it.`,
    );
  }

  for (const file of files) {
    if (file.existing === file.trigger.yaml) continue;
    await writeFile(
      file.destination,
      file.trigger.yaml,
      file.existing === undefined ? { flag: "wx" } : undefined,
    );
  }

  return {
    type: "single",
    data: {
      origin,
      directory,
      exported: files.filter(({ existing, trigger }) => existing !== trigger.yaml).length,
      unchanged: files.filter(({ existing, trigger }) => existing === trigger.yaml).length,
    },
    schema,
  };
}

export function addHubExportCommand(parent: Command, dependencies: HubExportDependencies): void {
  addJsonOption(
    addHubResolutionHelp(
      parent
        .command("export")
        .description("Export active Hub triggers as one YAML file per trigger")
        .argument("[directory]", "Destination directory", ".paseo/triggers")
        .option("--hub <origin>", "Paseo Hub origin")
        .option("--api-key <secret>", "Organization API key")
        .option("--force", "Replace trigger files with different contents"),
    ),
  ).action(
    withOutput(async (...args) => {
      const directory = args[0] as string | undefined;
      const options = args.at(-2) as HubExportOptions;
      return runHubExport(directory, options, dependencies);
    }),
  );
}

async function readOptionalFile(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
