import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";
import type { EditorTargetDescriptorPayload, EditorTargetId } from "../shared/messages.js";
import {
  findExecutable,
  quoteWindowsArgument,
  quoteWindowsCommand,
} from "../utils/executable.js";

type EditorTargetDefinition = {
  id: EditorTargetId;
  label: string;
  command: string;
  platforms?: readonly NodeJS.Platform[];
  excludedPlatforms?: readonly NodeJS.Platform[];
};

type ListAvailableEditorTargetsDependencies = {
  platform?: NodeJS.Platform;
  findExecutable?: (command: string) => string | null;
};

type OpenInEditorTargetDependencies = ListAvailableEditorTargetsDependencies & {
  existsSync?: typeof existsSync;
  spawn?: typeof spawn;
};

const EDITOR_TARGETS: readonly EditorTargetDefinition[] = [
  { id: "cursor", label: "Cursor", command: "cursor" },
  { id: "vscode", label: "VS Code", command: "code" },
  { id: "zed", label: "Zed", command: "zed" },
  { id: "finder", label: "Finder", command: "open", platforms: ["darwin"] },
  { id: "explorer", label: "Explorer", command: "explorer", platforms: ["win32"] },
  {
    id: "file-manager",
    label: "File Manager",
    command: "xdg-open",
    excludedPlatforms: ["darwin", "win32"],
  },
];

function isAbsolutePath(value: string): boolean {
  return posix.isAbsolute(value) || win32.isAbsolute(value);
}

function isTargetSupportedOnPlatform(
  target: EditorTargetDefinition,
  platform: NodeJS.Platform,
): boolean {
  if (target.platforms && !target.platforms.includes(platform)) {
    return false;
  }
  if (target.excludedPlatforms?.includes(platform)) {
    return false;
  }
  return true;
}

function resolveEditorTargetDefinition(editorId: EditorTargetId): EditorTargetDefinition {
  const target = EDITOR_TARGETS.find((entry) => entry.id === editorId);
  if (!target) {
    throw new Error(`Unknown editor target: ${editorId}`);
  }
  return target;
}

export function listAvailableEditorTargets(
  dependencies: ListAvailableEditorTargetsDependencies = {},
): EditorTargetDescriptorPayload[] {
  const platform = dependencies.platform ?? process.platform;
  const findExecutableFn = dependencies.findExecutable ?? findExecutable;

  return EDITOR_TARGETS.flatMap((target) => {
    if (!isTargetSupportedOnPlatform(target, platform)) {
      return [];
    }
    const executable = findExecutableFn(target.command);
    if (!executable) {
      return [];
    }

    return [
      {
        id: target.id,
        label: target.label,
      },
    ];
  });
}

type Launch = {
  command: string;
  args: string[];
};

function resolveEditorLaunch(input: {
  editorId: EditorTargetId;
  path: string;
  platform: NodeJS.Platform;
  findExecutableFn: typeof findExecutable;
}): Launch {
  const target = resolveEditorTargetDefinition(input.editorId);
  if (!isTargetSupportedOnPlatform(target, input.platform)) {
    throw new Error(`Editor target unavailable: ${target.label}`);
  }
  const executable = input.findExecutableFn(target.command);
  if (!executable) {
    throw new Error(`Editor target unavailable: ${target.label}`);
  }

  return {
    command: executable,
    args: [input.path],
  };
}

export async function openInEditorTarget(
  input: {
    editorId: EditorTargetId;
    path: string;
  },
  dependencies: OpenInEditorTargetDependencies = {},
): Promise<void> {
  const platform = dependencies.platform ?? process.platform;
  const pathToOpen = input.path.trim();
  const existsSyncFn = dependencies.existsSync ?? existsSync;
  const findExecutableFn = dependencies.findExecutable ?? findExecutable;
  const spawnFn = dependencies.spawn ?? spawn;

  if (!pathToOpen || !isAbsolutePath(pathToOpen)) {
    throw new Error("Editor target path must be an absolute local path");
  }
  if (!existsSyncFn(pathToOpen)) {
    throw new Error(`Path does not exist: ${pathToOpen}`);
  }

  const launch = resolveEditorLaunch({
    editorId: input.editorId,
    path: pathToOpen,
    platform,
    findExecutableFn,
  });

  const command = platform === "win32" ? quoteWindowsCommand(launch.command) : launch.command;
  const args =
    platform === "win32" ? launch.args.map((argument) => quoteWindowsArgument(argument)) : launch.args;

  await new Promise<void>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnFn(command, args, {
        detached: true,
        shell: platform === "win32",
        stdio: "ignore",
      });
    } catch (error) {
      reject(error);
      return;
    }

    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
