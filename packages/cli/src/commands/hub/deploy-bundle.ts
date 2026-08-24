import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { HubCommandError } from "./error.js";

const HUB_RESOURCE_PATH = ".paseo/hub.yml";
const LEGACY_TOML_PATH = ".paseo/hub.toml";
const WORKFLOW_DIRECTORY = ".paseo/workflows";
const PARTIAL_DIRECTORY = `${WORKFLOW_DIRECTORY}/partials`;
const PROJECT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export interface HubBundleFile {
  path: string;
  content: string;
}

export interface HubDeployBundle {
  projectSlug: string;
  files: readonly HubBundleFile[];
  workflowCount: number;
}

interface DiscoverHubBundleInput {
  cwd: string;
  project?: string;
}

export async function discoverHubBundle(input: DiscoverHubBundleInput): Promise<HubDeployBundle> {
  const projectSlug = requireProjectSlug(input.project);
  const root = path.resolve(input.cwd);
  await rejectLegacyToml(root);
  const resource = await readBundleFile(root, HUB_RESOURCE_PATH, {
    missingCode: "HUB_RESOURCE_MISSING",
    missingMessage: `${HUB_RESOURCE_PATH} does not exist. Run this command from the project root.`,
  });
  const workflowNames = await discoverWorkflowNames(root);
  const workflows = await Promise.all(
    workflowNames.map((name) => readBundleFile(root, `${WORKFLOW_DIRECTORY}/${name}`)),
  );
  const partialPaths = collectPartialPaths(workflows);
  const partials = await Promise.all(partialPaths.map((file) => readBundleFile(root, file)));
  const files = [resource, ...workflows, ...partials].toSorted(compareBundleFiles);
  assertUniqueBundlePaths(files);
  return { projectSlug, files, workflowCount: workflows.length };
}

function requireProjectSlug(project: string | undefined): string {
  if (project === undefined) {
    throw new HubCommandError(
      "HUB_PROJECT_REQUIRED",
      "Project is required. Pass --project <slug>.",
    );
  }
  if (!PROJECT_SLUG_PATTERN.test(project)) {
    throw new HubCommandError(
      "HUB_INVALID_PROJECT",
      "Project must be a bare slug such as my-project.",
    );
  }
  return project;
}

async function rejectLegacyToml(root: string): Promise<void> {
  try {
    await lstat(path.join(root, LEGACY_TOML_PATH));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw unreadablePath(LEGACY_TOML_PATH);
  }
  throw new HubCommandError(
    "HUB_CONFIGURATION_EXTENSION_UNSUPPORTED",
    `${LEGACY_TOML_PATH} is not supported. Use ${HUB_RESOURCE_PATH}.`,
  );
}

async function discoverWorkflowNames(root: string): Promise<readonly string[]> {
  const directory = path.join(root, WORKFLOW_DIRECTORY);
  await requireSafeDirectory(root, directory, WORKFLOW_DIRECTORY, {
    missingCode: "HUB_WORKFLOW_DIRECTORY_MISSING",
    missingMessage: `${WORKFLOW_DIRECTORY} does not exist.`,
  });
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    throw unreadablePath(WORKFLOW_DIRECTORY);
  }
  const names: string[] = [];
  for (const entry of entries.toSorted((left, right) => compareText(left.name, right.name))) {
    const bundlePath = `${WORKFLOW_DIRECTORY}/${entry.name}`;
    if (entry.isSymbolicLink()) throw unsafePath(bundlePath);
    if (entry.isDirectory()) {
      if (entry.name === "partials") continue;
      throw new HubCommandError(
        "HUB_WORKFLOW_PATH_UNSUPPORTED",
        `${bundlePath} is not a direct-child .yml workflow.`,
      );
    }
    if (!entry.isFile()) throw regularFileRequired(bundlePath);
    if (!entry.name.endsWith(".yml")) {
      throw new HubCommandError(
        "HUB_WORKFLOW_EXTENSION_UNSUPPORTED",
        `${bundlePath} must use the .yml extension.`,
      );
    }
    names.push(entry.name);
  }
  if (names.length === 0) {
    throw new HubCommandError(
      "HUB_WORKFLOW_MISSING",
      `${WORKFLOW_DIRECTORY} must contain at least one direct-child .yml workflow.`,
    );
  }
  return names;
}

function collectPartialPaths(workflows: readonly HubBundleFile[]): readonly string[] {
  const paths = new Set<string>();
  for (const workflow of workflows) {
    let document: unknown;
    try {
      document = YAML.parse(workflow.content);
    } catch {
      throw new HubCommandError("HUB_WORKFLOW_INVALID_YAML", `${workflow.path} is not valid YAML.`);
    }
    if (!isRecord(document) || !Array.isArray(document["steps"])) continue;
    for (const step of document["steps"]) {
      if (!isRecord(step) || !Array.isArray(step["prompt"])) continue;
      for (const block of step["prompt"]) {
        if (!isRecord(block) || !Object.hasOwn(block, "include")) continue;
        const include = block["include"];
        if (typeof include !== "string") {
          throw invalidPartialPath(workflow.path, String(include));
        }
        paths.add(resolvePartialPath(workflow.path, include));
      }
    }
  }
  return [...paths].sort(compareText);
}

function resolvePartialPath(workflowPath: string, include: string): string {
  const decoded = decodePartialPath(workflowPath, include);
  if (/^(?:[a-zA-Z]:[\\/]|[\\/]{1,2})/u.test(decoded)) {
    throw invalidPartialPath(workflowPath, include);
  }
  const segments = decoded.replaceAll("\\", "/").split("/");
  if (
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..") ||
    segments[0] !== "partials"
  ) {
    throw invalidPartialPath(workflowPath, include);
  }
  return `${WORKFLOW_DIRECTORY}/${segments.join("/")}`;
}

function decodePartialPath(workflowPath: string, include: string): string {
  let decoded = include;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      throw invalidPartialPath(workflowPath, include);
    }
    if (next === decoded) break;
    decoded = next;
  }
  if (decoded.includes("\0") || /%[0-9a-f]{2}/iu.test(decoded)) {
    throw invalidPartialPath(workflowPath, include);
  }
  return decoded;
}

async function readBundleFile(
  root: string,
  bundlePath: string,
  missing: { missingCode: string; missingMessage: string } = {
    missingCode: "HUB_BUNDLE_FILE_MISSING",
    missingMessage: `${bundlePath} does not exist.`,
  },
): Promise<HubBundleFile> {
  const absolutePath = path.join(root, ...bundlePath.split("/"));
  await rejectSymlinkComponents(root, absolutePath, bundlePath);
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(absolutePath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new HubCommandError(missing.missingCode, missing.missingMessage);
    }
    throw unreadablePath(bundlePath);
  }
  if (stats.isSymbolicLink()) throw unsafePath(bundlePath);
  if (!stats.isFile()) throw regularFileRequired(bundlePath);
  if (!hasReadPermission(stats.mode)) throw unreadablePath(bundlePath);
  try {
    return { path: bundlePath, content: (await readFile(absolutePath)).toString("utf8") };
  } catch {
    throw unreadablePath(bundlePath);
  }
}

async function requireSafeDirectory(
  root: string,
  absolutePath: string,
  bundlePath: string,
  missing: { missingCode: string; missingMessage: string },
): Promise<void> {
  await rejectSymlinkComponents(root, absolutePath, bundlePath);
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(absolutePath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new HubCommandError(missing.missingCode, missing.missingMessage);
    }
    throw unreadablePath(bundlePath);
  }
  if (stats.isSymbolicLink()) throw unsafePath(bundlePath);
  if (!stats.isDirectory()) {
    throw new HubCommandError(
      "HUB_WORKFLOW_DIRECTORY_INVALID",
      `${bundlePath} must be a directory.`,
    );
  }
}

async function rejectSymlinkComponents(
  root: string,
  target: string,
  bundlePath: string,
): Promise<void> {
  const relative = path.relative(root, target);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw unsafePath(bundlePath);
    } catch (error) {
      if (error instanceof HubCommandError) throw error;
      if (errorCode(error) === "ENOENT") return;
      throw unreadablePath(bundlePath);
    }
  }
}

function assertUniqueBundlePaths(files: readonly HubBundleFile[]): void {
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.path)) {
      throw new HubCommandError(
        "HUB_BUNDLE_PATH_DUPLICATE",
        `${file.path} appears more than once in the discovered bundle.`,
      );
    }
    seen.add(file.path);
  }
}

function invalidPartialPath(workflowPath: string, include: string): HubCommandError {
  return new HubCommandError(
    "HUB_PARTIAL_PATH_INVALID",
    `${workflowPath} includes an unsafe path outside ${PARTIAL_DIRECTORY}: ${include}`,
  );
}

function unsafePath(bundlePath: string): HubCommandError {
  return new HubCommandError("HUB_BUNDLE_UNSAFE_PATH", `${bundlePath} must not use a symlink.`);
}

function unreadablePath(bundlePath: string): HubCommandError {
  return new HubCommandError(
    "HUB_BUNDLE_UNREADABLE",
    `Could not read ${bundlePath}. Check the file and permissions.`,
  );
}

function regularFileRequired(bundlePath: string): HubCommandError {
  return new HubCommandError("HUB_BUNDLE_NOT_FILE", `${bundlePath} must be a regular file.`);
}

function compareBundleFiles(left: HubBundleFile, right: HubBundleFile): number {
  return compareText(left.path, right.path);
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
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
