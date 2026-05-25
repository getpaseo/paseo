interface DesktopFilePathBridge {
  platform?: string;
  webUtils?: {
    getPathForFile?: (file: File) => string;
  };
}

const DANGEROUS_NON_WINDOWS_PATH_CHARS = /[`$|&>~#!^*;<]/g;

function getDesktopBridge(): DesktopFilePathBridge | null {
  if (typeof window === "undefined") {
    return null;
  }
  const bridge = (window as unknown as { paseoDesktop?: DesktopFilePathBridge }).paseoDesktop;
  return bridge && typeof bridge === "object" ? bridge : null;
}

function getLegacyFilePath(file: File): string | null {
  const path = Reflect.get(file, "path");
  return typeof path === "string" && path.length > 0 ? path : null;
}

function getFilePath(file: File): string | null {
  const bridge = getDesktopBridge();
  const getPathForFile = bridge?.webUtils?.getPathForFile;
  if (typeof getPathForFile === "function") {
    try {
      const path = getPathForFile(file);
      if (typeof path === "string" && path.length > 0) {
        return path;
      }
    } catch {
      // Fall through to the legacy Electron File.path property if present.
    }
  }
  return getLegacyFilePath(file);
}

export function isTerminalFileDrag(dataTransfer: DataTransfer | null): boolean {
  return Boolean(dataTransfer && Array.from(dataTransfer.types).includes("Files"));
}

export function isTerminalDragLeaveOutside(input: {
  currentTarget: EventTarget | null;
  relatedTarget: EventTarget | null;
}): boolean {
  if (!(input.currentTarget instanceof Node) || !(input.relatedTarget instanceof Node)) {
    return true;
  }
  return !input.currentTarget.contains(input.relatedTarget);
}

export function extractTerminalDropPaths(dataTransfer: DataTransfer | null): string[] {
  if (!dataTransfer) {
    return [];
  }

  const paths: string[] = [];
  for (const file of Array.from(dataTransfer.files)) {
    const path = getFilePath(file);
    if (path) {
      paths.push(path);
    }
  }
  return paths;
}

function escapeNonWindowsPath(path: string): string {
  let nextPath = path;
  if (nextPath.includes("\\")) {
    nextPath = nextPath.replace(/\\/g, "\\\\");
  }

  nextPath = nextPath.replace(DANGEROUS_NON_WINDOWS_PATH_CHARS, "");

  if (nextPath.includes("'") && nextPath.includes('"')) {
    return `$'${nextPath.replace(/'/g, "\\'")}'`;
  }
  if (nextPath.includes("'")) {
    return `'${nextPath.replace(/'/g, "\\'")}'`;
  }
  return `'${nextPath}'`;
}

function escapeWindowsPath(path: string): string {
  if (!path.includes(" ")) {
    return path;
  }
  return `"${path}"`;
}

export function prepareDroppedPathForTerminal(path: string): string {
  const platform = getDesktopBridge()?.platform;
  if (platform === "win32") {
    return escapeWindowsPath(path);
  }
  return escapeNonWindowsPath(path);
}

export function prepareDroppedPathsForTerminal(paths: readonly string[]): string {
  return paths.map(prepareDroppedPathForTerminal).join(" ");
}
