import { isAbsolutePath } from "@/utils/path";

export type InlinePathOpenPlan =
  | { kind: "file" }
  | { kind: "directory"; directoryPath: string }
  | {
      kind: "probe";
      /** The root to list, relative to which `relativePath` is resolved. */
      root: string;
      relativePath: string;
      /** Whether the probed path lives inside the workspace root. */
      underWorkspace: boolean;
    };

/**
 * Decides how an inline path press opens. Extension-less paths without a line number
 * cannot be told apart from folders lexically ("moys-asr-workflow" is a folder,
 * "Makefile" is a file), so they come back as "probe" and the caller asks the daemon
 * which one it is before opening a file tab that would fail with
 * "Requested path is not a file".
 *
 * Paths inside the workspace root are probed against that root. Absolute paths outside
 * it are probed against their own parent directory, so the caller can offer the system
 * file manager for external folders.
 */
export function planInlinePathOpen(input: {
  file?: string;
  lineStart?: number;
  workspaceRoot: string;
}): InlinePathOpenPlan {
  const { file, lineStart, workspaceRoot } = input;
  if (!file) {
    // Lexical directory: a trailing slash, ".", or the workspace root itself.
    return { kind: "directory", directoryPath: "." };
  }
  if (!file.trim() || lineStart !== undefined || hasFileExtension(file)) {
    return { kind: "file" };
  }

  const normalizedPath = normalizeSlashes(file);
  const normalizedRoot = normalizeSlashes(workspaceRoot);

  if (!isAbsolutePath(normalizedPath)) {
    if (!normalizedRoot) {
      return { kind: "file" };
    }
    return {
      kind: "probe",
      root: normalizedRoot,
      relativePath: normalizedPath,
      underWorkspace: true,
    };
  }

  if (normalizedRoot && isPathWithinRoot(normalizedPath, normalizedRoot)) {
    return {
      kind: "probe",
      root: normalizedRoot,
      relativePath: relativeWithinRoot(normalizedPath, normalizedRoot),
      underWorkspace: true,
    };
  }

  const segments = normalizedPath.split("/");
  const basename = segments[segments.length - 1];
  const dirname = segments.slice(0, -1).join("/");
  if (!dirname || !basename) {
    return { kind: "file" };
  }
  return {
    kind: "probe",
    root: dirname,
    relativePath: basename,
    underWorkspace: false,
  };
}

/** The absolute path a probe plan resolved to, for callers that act outside the workspace. */
export function planProbeAbsolutePath(
  plan: Extract<InlinePathOpenPlan, { kind: "probe" }>,
): string {
  return plan.relativePath === "." ? plan.root : `${plan.root}/${plan.relativePath}`;
}

export interface InlinePathOpenActions {
  /** The daemon client used for directory probes; null skips probing and opens a file. */
  client: { listDirectory(root: string, path: string): Promise<unknown> } | null;
  openFile: () => void;
  openExplorerAt: (directoryPath: string) => void;
  revealInFileManager: (absolutePath: string) => void;
}

/**
 * Executes a plan: opens files directly, asks the daemon to tell folders from files for
 * probes, then either navigates the workspace explorer (inside the workspace) or hands the
 * folder to the system file manager (outside it). Falls back to opening a file when the
 * probe is unavailable or reports a file.
 */
export async function openInlinePathPlan(
  plan: InlinePathOpenPlan,
  workspaceRoot: string,
  actions: InlinePathOpenActions,
): Promise<void> {
  if (plan.kind === "file") {
    actions.openFile();
    return;
  }

  if (plan.kind === "directory") {
    const directoryPlan = planInlinePathOpen({
      file: plan.directoryPath,
      workspaceRoot,
    });
    if (directoryPlan.kind === "probe" && !directoryPlan.underWorkspace) {
      actions.revealInFileManager(planProbeAbsolutePath(directoryPlan));
      return;
    }
    actions.openExplorerAt(plan.directoryPath);
    return;
  }

  if (!actions.client) {
    actions.openFile();
    return;
  }

  try {
    await actions.client.listDirectory(plan.root, plan.relativePath);
  } catch {
    actions.openFile();
    return;
  }

  if (plan.underWorkspace) {
    actions.openExplorerAt(plan.relativePath);
    return;
  }
  actions.revealInFileManager(planProbeAbsolutePath(plan));
}

function hasFileExtension(value: string): boolean {
  const lastSegment = value.split("/").pop() ?? "";
  return /\.[A-Za-z0-9]+$/.test(lastSegment);
}

function normalizeSlashes(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

function isPathWithinRoot(path: string, root: string): boolean {
  if (!root) {
    return false;
  }
  const candidate = lowerIfDrive(path);
  const lowerRoot = lowerIfDrive(root);
  return candidate === lowerRoot || candidate.startsWith(`${lowerRoot}/`);
}

function relativeWithinRoot(path: string, root: string): string {
  if (lowerIfDrive(path) === lowerIfDrive(root)) {
    return ".";
  }
  return path.slice(root.length + 1);
}

function lowerIfDrive(value: string): string {
  return /^[A-Za-z]:/.test(value) ? value.toLowerCase() : value;
}
