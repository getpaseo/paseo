import type { EditorTarget, EditorTargetDirectoryEntry, EditorTargetRuntime } from "../target.js";

const XCODE_APPLICATION_NAME = "Xcode";
const SWIFT_PACKAGE_MANIFEST = "Package.swift";

function joinPath(directory: string, entry: string): string {
  return `${directory.replace(/\/+$/u, "")}/${entry}`;
}

function directoryName(directory: string): string {
  const segments = directory.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? "";
}

function pickByExtension(
  entries: readonly EditorTargetDirectoryEntry[],
  directory: string,
  extension: string,
): string | null {
  const matches = entries
    .filter((entry) => entry.kind === "directory" && entry.name.endsWith(extension))
    .map((entry) => entry.name)
    .sort();
  if (matches.length === 0) return null;
  // A repo can hold several projects; the one named after its directory is the
  // umbrella project far more often than not, so prefer it before falling back
  // to alphabetical order.
  const preferred = `${directoryName(directory)}${extension}`;
  return matches.includes(preferred) ? preferred : matches[0];
}

/**
 * Resolves what Xcode should actually be handed. Xcode cannot open a plain
 * directory, so the workspace root is searched for a document it understands:
 * an `.xcworkspace` first (it supersedes the projects it contains), then an
 * `.xcodeproj`, then a Swift package manifest.
 */
export function findXcodeDocument(
  workspacePath: string,
  runtime: EditorTargetRuntime,
): string | null {
  const entries = runtime.listDirectory(workspacePath);
  const workspace = pickByExtension(entries, workspacePath, ".xcworkspace");
  if (workspace) return joinPath(workspacePath, workspace);
  const project = pickByExtension(entries, workspacePath, ".xcodeproj");
  if (project) return joinPath(workspacePath, project);
  if (entries.some((entry) => entry.kind === "file" && entry.name === SWIFT_PACKAGE_MANIFEST)) {
    return joinPath(workspacePath, SWIFT_PACKAGE_MANIFEST);
  }
  return null;
}

export const xcodeTarget: EditorTarget = {
  id: "xcode",
  async describe(runtime) {
    return {
      id: this.id,
      label: "Xcode",
      kind: "editor",
      icon: await runtime.loadIcon("xcode.png"),
    };
  },
  async isInstalled(runtime) {
    return runtime.hasMacApplication(XCODE_APPLICATION_NAME);
  },
  async supportsWorkspace(workspacePath, runtime) {
    return findXcodeDocument(workspacePath, runtime) !== null;
  },
  async launch(input, runtime) {
    const document = findXcodeDocument(input.workspacePath, runtime);
    if (!document) {
      throw new Error(`No Xcode project, workspace, or Swift package in ${input.workspacePath}`);
    }
    const applicationPath = runtime.getMacApplicationBundle(XCODE_APPLICATION_NAME);
    if (!applicationPath) throw new Error("Xcode is not installed");
    // Xcode has no CLI for line/column, so a requested file is handed over as a
    // second document and Xcode reveals it inside the project it belongs to.
    await runtime.openMacApplication({
      applicationName: XCODE_APPLICATION_NAME,
      applicationPath,
      paths: input.filePath ? [document, input.filePath] : [document],
    });
  },
};
