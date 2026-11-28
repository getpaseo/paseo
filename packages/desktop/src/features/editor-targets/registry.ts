import type {
  EditorTarget,
  EditorTargetDescriptor,
  EditorTargetLaunchInput,
  EditorTargetRuntime,
} from "./target.js";
import { androidStudioTarget } from "./targets/android-studio.js";
import { antigravityTarget } from "./targets/antigravity.js";
import { aquaTarget } from "./targets/aqua.js";
import { clionTarget } from "./targets/clion.js";
import { cursorTarget } from "./targets/cursor.js";
import { datagripTarget } from "./targets/datagrip.js";
import { dataspellTarget } from "./targets/dataspell.js";
import { explorerTarget, fileManagerTarget, finderTarget } from "./targets/file-manager.js";
import { golandTarget } from "./targets/goland.js";
import { intellijIdeaTarget } from "./targets/intellij-idea.js";
import { kiroTarget } from "./targets/kiro.js";
import { phpstormTarget } from "./targets/phpstorm.js";
import { pycharmTarget } from "./targets/pycharm.js";
import { riderTarget } from "./targets/rider.js";
import { rubymineTarget } from "./targets/rubymine.js";
import { rustroverTarget } from "./targets/rustrover.js";
import { traeTarget } from "./targets/trae.js";
import { vscodiumTarget } from "./targets/vscodium.js";
import { vscodeInsidersTarget } from "./targets/vscode-insiders.js";
import { vscodeTarget } from "./targets/vscode.js";
import { webstormTarget } from "./targets/webstorm.js";
import { xcodeTarget } from "./targets/xcode.js";
import { zedTarget } from "./targets/zed.js";

export const EDITOR_TARGETS: readonly EditorTarget[] = [
  cursorTarget,
  traeTarget,
  kiroTarget,
  vscodeTarget,
  vscodeInsidersTarget,
  vscodiumTarget,
  zedTarget,
  antigravityTarget,
  androidStudioTarget,
  xcodeTarget,
  intellijIdeaTarget,
  aquaTarget,
  clionTarget,
  datagripTarget,
  dataspellTarget,
  golandTarget,
  phpstormTarget,
  pycharmTarget,
  riderTarget,
  rubymineTarget,
  rustroverTarget,
  webstormTarget,
  finderTarget,
  explorerTarget,
  fileManagerTarget,
];

export interface ListEditorTargetsOptions {
  /**
   * Absolute workspace root. Without it, targets that declare
   * `supportsWorkspace` are left out — there is nothing to match them against.
   */
  workspacePath?: string;
}

export async function listAvailableEditorTargets(
  runtime: EditorTargetRuntime,
  targets: readonly EditorTarget[] = EDITOR_TARGETS,
  options: ListEditorTargetsOptions = {},
): Promise<EditorTargetDescriptor[]> {
  const workspacePath =
    options.workspacePath && runtime.isAbsolutePath(options.workspacePath)
      ? options.workspacePath
      : null;
  const descriptors: EditorTargetDescriptor[] = [];
  for (const target of targets) {
    if (!(await target.isInstalled(runtime))) continue;
    if (!target.supportsWorkspace) {
      descriptors.push(await target.describe(runtime));
      continue;
    }
    if (!workspacePath) continue;
    if (!(await target.supportsWorkspace(workspacePath, runtime))) continue;
    descriptors.push(await target.describe(runtime));
  }
  return descriptors;
}

export function getEditorTarget(
  id: string,
  targets: readonly EditorTarget[] = EDITOR_TARGETS,
): EditorTarget {
  const target = targets.find((candidate) => candidate.id === id);
  if (!target) throw new Error(`Unknown editor target: ${id}`);
  return target;
}

// Assistant replies name paths like `~/Downloads/x`; expand them before the absolute-path guard.
function resolveLocalPath(path: string, label: string, runtime: EditorTargetRuntime): string {
  const expanded = runtime.expandHomePath(path);
  if (!runtime.isAbsolutePath(expanded)) {
    throw new Error(`${label} must be an absolute local path`);
  }
  if (!runtime.pathExists(expanded)) {
    throw new Error(`Path does not exist: ${expanded}`);
  }
  return expanded;
}

export async function openEditorTarget(
  request: EditorTargetLaunchInput & { editorId: string },
  runtime: EditorTargetRuntime,
  targets: readonly EditorTarget[] = EDITOR_TARGETS,
): Promise<void> {
  const input = {
    ...request,
    workspacePath: resolveLocalPath(request.workspacePath, "Editor target workspace path", runtime),
    filePath:
      request.filePath === undefined
        ? undefined
        : resolveLocalPath(request.filePath, "Editor target file path", runtime),
  };

  const target = getEditorTarget(input.editorId, targets);
  if (!(await target.isInstalled(runtime))) {
    const descriptor = await target.describe(runtime);
    throw new Error(`Editor target unavailable: ${descriptor.label}`);
  }
  await target.launch(input, runtime);
}

/** Opens a file with whatever application the operating system associates with it. */
export async function openInDefaultApp(path: string, runtime: EditorTargetRuntime): Promise<void> {
  await runtime.openPath(resolveLocalPath(path, "Default app path", runtime));
}
