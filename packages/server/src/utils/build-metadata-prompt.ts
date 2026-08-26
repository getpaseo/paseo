import {
  PaseoConfigRawSchema,
  PaseoConfigSchema,
  PaseoMetadataGenerationEntrySchema,
  PaseoMetadataGenerationSchema,
  type PaseoMetadataGeneration,
} from "@getpaseo/protocol/paseo-config-schema";

export type MetadataConfigKey = "title" | "branchName" | "commitMessage" | "pullRequest";

export interface CommittedFileReader {
  readHeadFile(path: string, options: { maxBytes: number }): Promise<string | null>;
}

export interface MetadataStyleSection {
  configKey: MetadataConfigKey;
  default: string;
  label?: string;
}

export interface BuildMetadataPromptOptions {
  contract: string;
  styles: MetadataStyleSection[];
  after: string;
  trailing?: string;
  metadataGeneration?: PaseoMetadataGeneration;
}

const MAX_PASEO_CONFIG_BYTES = 1024 * 1024;
const CommittedMetadataGenerationSchema = PaseoMetadataGenerationSchema.unwrap().extend({
  title: PaseoMetadataGenerationEntrySchema.unwrap().optional(),
  branchName: PaseoMetadataGenerationEntrySchema.unwrap().optional(),
  commitMessage: PaseoMetadataGenerationEntrySchema.unwrap().optional(),
  pullRequest: PaseoMetadataGenerationEntrySchema.unwrap().optional(),
});

export function buildMetadataPrompt(options: BuildMetadataPromptOptions): string {
  const styleBlocks = options.styles.map((section) =>
    renderStyleSection(section, options.metadataGeneration?.[section.configKey]?.instructions),
  );
  const head = [options.contract, ...styleBlocks, options.after].join("\n\n");
  return options.trailing ? `${head}\n\n${options.trailing}` : head;
}

export async function loadCommittedMetadataGeneration(
  reader: CommittedFileReader,
): Promise<PaseoMetadataGeneration | undefined> {
  const source = await reader.readHeadFile("paseo.json", {
    maxBytes: MAX_PASEO_CONFIG_BYTES,
  });
  if (source === null) {
    return undefined;
  }

  let json: unknown;
  try {
    json = JSON.parse(source);
  } catch {
    throw new Error("Committed paseo.json contains invalid JSON");
  }

  try {
    const rawConfig = PaseoConfigRawSchema.parse(json);
    const metadataGeneration = (json as Record<string, unknown>).metadataGeneration;
    CommittedMetadataGenerationSchema.optional().parse(metadataGeneration);
    return PaseoConfigSchema.parse(rawConfig).metadataGeneration;
  } catch {
    throw new Error("Committed paseo.json does not match the Paseo configuration schema");
  }
}

function renderStyleSection(section: MetadataStyleSection, override: string | undefined): string {
  const body = isNonEmptyString(override) ? override.trim() : section.default;
  return section.label ? `${section.label}:\n${body}` : body;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}
