import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { HubDeployError } from "./error.js";

const DEFAULT_CONFIGURATION_PATH = ".paseo/hub.yml";
const PROMPT_PARTIAL_ROOT = ".paseo/partials";
const PROMPT_PARTIAL_ROOT_PREFIX = `${PROMPT_PARTIAL_ROOT}/`;
const PROJECT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const MAX_CONFIGURATION_BYTES = 1_000_000;
const MAX_PROMPT_PARTIAL_COUNT = 100;
const MAX_PROMPT_PARTIAL_PATH_LENGTH = 512;
const MAX_PROMPT_PARTIAL_CONTENT_BYTES = 1_000_000;
const MAX_PROMPT_PARTIAL_BUNDLE_BYTES = 5_000_000;

export interface HubDeployPartial {
  path: string;
  content: string;
}

export interface HubDeployInput {
  projectSlug: string;
  yaml: string;
  partials?: readonly HubDeployPartial[];
}

interface ResolveHubDeployInput {
  cwd: string;
  file?: string;
  project?: string;
}

export async function resolveHubDeployInput(input: ResolveHubDeployInput): Promise<HubDeployInput> {
  const file = input.file ?? DEFAULT_CONFIGURATION_PATH;
  const projectRoot = path.resolve(input.cwd);
  const configurationPath = resolveConfigurationPath(projectRoot, file);
  const yaml = await readConfiguration(projectRoot, configurationPath, file);
  const configuration = parseConfiguration(yaml);
  const projectSlug = input.project ?? projectFromConfiguration(configuration);

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

  const partials = await resolvePromptPartials(projectRoot, configuration);
  return {
    projectSlug,
    yaml,
    ...(partials.length === 0 ? {} : { partials }),
  };
}

function resolveConfigurationPath(cwd: string, file: string): string {
  if (file.length === 0 || file.includes("\0")) {
    throw invalidConfigurationPath();
  }

  const segments = file.replaceAll("\\", "/").split("/");
  if (segments.some((segment) => segment === "..")) {
    throw invalidConfigurationPath();
  }

  const resolved = path.resolve(cwd, file);
  const relative = path.relative(cwd, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw invalidConfigurationPath();
  }
  return resolved;
}

async function readConfiguration(
  projectRoot: string,
  configurationPath: string,
  displayPath: string,
): Promise<string> {
  const unsafePath = () =>
    new HubDeployError(
      "HUB_CONFIGURATION_UNSAFE_PATH",
      `Hub configuration at ${displayPath} must not use a symlink.`,
    );
  await rejectSymlinkComponents(projectRoot, configurationPath, unsafePath);

  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(configurationPath);
  } catch (error) {
    throw configurationReadError(displayPath, error);
  }
  if (stats.isSymbolicLink()) {
    throw unsafePath();
  }
  if (!stats.isFile()) {
    throw new HubDeployError(
      "HUB_CONFIGURATION_NOT_FILE",
      `Hub configuration at ${displayPath} must be a regular file.`,
    );
  }
  if (!hasReadPermission(stats.mode)) {
    throw new HubDeployError(
      "HUB_CONFIGURATION_UNREADABLE",
      `Could not read Hub configuration at ${displayPath}. Check file permissions.`,
    );
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(configurationPath);
  } catch (error) {
    throw configurationReadError(displayPath, error);
  }
  if (bytes.byteLength > MAX_CONFIGURATION_BYTES) {
    throw new HubDeployError(
      "HUB_CONFIGURATION_TOO_LARGE",
      `Hub configuration at ${displayPath} exceeds the ${MAX_CONFIGURATION_BYTES}-byte limit.`,
    );
  }
  return bytes.toString("utf8");
}

function parseConfiguration(yaml: string): Record<string, unknown> {
  let configuration: unknown;
  try {
    configuration = YAML.parse(yaml);
  } catch {
    throw new HubDeployError("HUB_INVALID_CONFIGURATION", "Hub configuration is not valid YAML.");
  }
  if (!isRecord(configuration)) {
    throw new HubDeployError(
      "HUB_INVALID_CONFIGURATION",
      "Hub configuration must be a YAML mapping.",
    );
  }
  return configuration;
}

function projectFromConfiguration(configuration: Record<string, unknown>): string | undefined {
  const project: unknown = configuration["project"];
  if (project === undefined) return undefined;
  if (typeof project !== "string") {
    throw new HubDeployError(
      "HUB_INVALID_PROJECT",
      "Top-level project must be a bare project slug.",
    );
  }
  return project;
}

async function resolvePromptPartials(
  projectRoot: string,
  configuration: Record<string, unknown>,
): Promise<HubDeployPartial[]> {
  const references = collectPromptPartialReferences(configuration);
  if (references.length > MAX_PROMPT_PARTIAL_COUNT) {
    throw new HubDeployError(
      "HUB_PARTIAL_LIMIT_EXCEEDED",
      `Hub configuration references ${references.length} partials; the limit is ${MAX_PROMPT_PARTIAL_COUNT}.`,
    );
  }

  const partials: HubDeployPartial[] = [];
  let bundleBytes = 0;
  for (const reference of references) {
    const partialPath = path.resolve(
      projectRoot,
      PROMPT_PARTIAL_ROOT,
      ...reference.path.split("/"),
    );
    const content = await readPartial(projectRoot, partialPath, reference.path);
    const contentBytes = Buffer.byteLength(content, "utf8");
    if (contentBytes > MAX_PROMPT_PARTIAL_CONTENT_BYTES) {
      throw new HubDeployError(
        "HUB_PARTIAL_TOO_LARGE",
        `Referenced Hub partial ${reference.path} exceeds the ${MAX_PROMPT_PARTIAL_CONTENT_BYTES}-byte limit.`,
      );
    }
    bundleBytes += contentBytes;
    if (bundleBytes > MAX_PROMPT_PARTIAL_BUNDLE_BYTES) {
      throw new HubDeployError(
        "HUB_PARTIAL_BUNDLE_TOO_LARGE",
        `Referenced Hub partials exceed the ${MAX_PROMPT_PARTIAL_BUNDLE_BYTES}-byte combined limit.`,
      );
    }
    partials.push({ path: reference.path, content });
  }
  return partials;
}

interface PromptPartialReference {
  path: string;
}

function collectPromptPartialReferences(
  configuration: Record<string, unknown>,
): PromptPartialReference[] {
  const references: PromptPartialReference[] = [];
  const seen = new Set<string>();
  const triggers = configuration["triggers"];
  if (!Array.isArray(triggers)) return references;

  for (const trigger of triggers) {
    if (!isRecord(trigger) || !Array.isArray(trigger["steps"])) continue;
    for (const step of trigger["steps"]) {
      if (!isRecord(step) || !Array.isArray(step["prompt"])) continue;
      for (const block of step["prompt"]) {
        if (!isRecord(block) || !Object.hasOwn(block, "include")) continue;
        const include = block["include"];
        if (typeof include !== "string") {
          throw new HubDeployError(
            "HUB_PARTIAL_PATH_INVALID",
            "Hub partial include path must be a string.",
          );
        }
        const normalizedPath = normalizePromptPartialPath(include);
        if (seen.has(normalizedPath)) {
          throw new HubDeployError(
            "HUB_PARTIAL_DUPLICATE",
            `Hub partial ${normalizedPath} is referenced more than once. Remove the duplicate include.`,
          );
        }
        seen.add(normalizedPath);
        references.push({ path: normalizedPath });
      }
    }
  }
  return references;
}

function normalizePromptPartialPath(value: string): string {
  const decoded = decodePromptPartialPath(value);
  if (decoded.length === 0) throw invalidPromptPartialPath(value);
  if (/^(?:[a-zA-Z]:[\\/]|[\\/]{1,2})/u.test(decoded)) {
    throw invalidPromptPartialPath(value);
  }

  const segments = decoded.replaceAll("\\", "/").split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw invalidPromptPartialPath(value);
  }
  const canonical = `${PROMPT_PARTIAL_ROOT}/${segments.join("/")}`;
  if (!canonical.startsWith(PROMPT_PARTIAL_ROOT_PREFIX)) {
    throw invalidPromptPartialPath(value);
  }
  if (canonical.length > MAX_PROMPT_PARTIAL_PATH_LENGTH) {
    throw new HubDeployError(
      "HUB_PARTIAL_PATH_TOO_LONG",
      `Hub partial path ${value} exceeds the ${MAX_PROMPT_PARTIAL_PATH_LENGTH}-character limit.`,
    );
  }
  return canonical.slice(PROMPT_PARTIAL_ROOT_PREFIX.length);
}

function decodePromptPartialPath(value: string): string {
  let decoded = value;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      throw invalidPromptPartialPath(value);
    }
    if (next === decoded) break;
    decoded = next;
  }
  if (decoded.includes("\0") || /%[0-9a-f]{2}/iu.test(decoded)) {
    throw invalidPromptPartialPath(value);
  }
  return decoded;
}

async function readPartial(
  projectRoot: string,
  partialPath: string,
  displayPath: string,
): Promise<string> {
  await rejectSymlinkComponents(
    projectRoot,
    partialPath,
    () =>
      new HubDeployError(
        "HUB_PARTIAL_UNSAFE_PATH",
        `Referenced Hub partial ${displayPath} must not use a symlink.`,
      ),
  );

  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(partialPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new HubDeployError(
        "HUB_PARTIAL_MISSING",
        `Referenced Hub partial ${displayPath} does not exist.`,
      );
    }
    throw new HubDeployError(
      "HUB_PARTIAL_UNREADABLE",
      `Could not read referenced Hub partial ${displayPath}. Check the file and permissions.`,
    );
  }
  if (stats.isSymbolicLink()) {
    throw new HubDeployError(
      "HUB_PARTIAL_UNSAFE_PATH",
      `Referenced Hub partial ${displayPath} must not be a symlink.`,
    );
  }
  if (!stats.isFile()) {
    throw new HubDeployError(
      "HUB_PARTIAL_NOT_FILE",
      `Referenced Hub partial ${displayPath} must be a regular file.`,
    );
  }
  if (!hasReadPermission(stats.mode)) {
    throw new HubDeployError(
      "HUB_PARTIAL_UNREADABLE",
      `Could not read referenced Hub partial ${displayPath}. Check the file and permissions.`,
    );
  }

  try {
    return (await readFile(partialPath)).toString("utf8");
  } catch {
    throw new HubDeployError(
      "HUB_PARTIAL_UNREADABLE",
      `Could not read referenced Hub partial ${displayPath}. Check the file and permissions.`,
    );
  }
}

async function rejectSymlinkComponents(
  root: string,
  target: string,
  error: () => HubDeployError,
): Promise<void> {
  const relative = path.relative(root, target);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw error();
    } catch (failure) {
      if (failure instanceof HubDeployError) throw failure;
      if (errorCode(failure) === "ENOENT") return;
      throw error();
    }
  }
}

function configurationReadError(displayPath: string, error: unknown): HubDeployError {
  if (errorCode(error) === "ENOENT") {
    return new HubDeployError(
      "HUB_CONFIGURATION_UNREADABLE",
      `Could not read Hub configuration at ${displayPath}. Pass an existing YAML file.`,
    );
  }
  return new HubDeployError(
    "HUB_CONFIGURATION_UNREADABLE",
    `Could not read Hub configuration at ${displayPath}. Check the file and permissions.`,
  );
}

function invalidConfigurationPath(): HubDeployError {
  return new HubDeployError(
    "HUB_CONFIGURATION_PATH_INVALID",
    "Hub configuration path must stay within the current project root; parent-directory paths are not allowed.",
  );
}

function invalidPromptPartialPath(value: string): HubDeployError {
  return new HubDeployError(
    "HUB_PARTIAL_PATH_INVALID",
    `Hub partial path must be a safe relative path under .paseo/partials/: ${value}`,
  );
}

function hasReadPermission(mode: number): boolean {
  return (mode & 0o444) !== 0;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
