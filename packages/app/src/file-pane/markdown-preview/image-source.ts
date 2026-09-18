import { localFileSourceToPath } from "@/attachments/utils";
import { isAbsolutePath } from "@/utils/path";

function trimTrailingSeparators(value: string): string {
  if (value === "/" || /^[A-Za-z]:[\\/]?$/.test(value)) {
    return value.replace(/\\/g, "/");
  }
  return value.replace(/[\\/]+$/, "");
}

function normalizePathSegments(value: string): string {
  const segments: string[] = [];
  for (const segment of value.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length > 0) {
        segments.pop();
      }
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

function normalizeAbsolutePath(value: string): string | null {
  const normalizedInput = trimTrailingSeparators(value.replace(/\\/g, "/"));
  if (!isAbsolutePath(normalizedInput)) {
    return null;
  }

  const drivePath = /^([A-Za-z]:)\/(.*)$/.exec(normalizedInput);
  if (drivePath) {
    return trimTrailingSeparators(`${drivePath[1]}/${normalizePathSegments(drivePath[2])}`);
  }

  const prefix = normalizedInput.startsWith("//") ? "//" : "/";
  return trimTrailingSeparators(
    `${prefix}${normalizePathSegments(normalizedInput.replace(/^\/+/, ""))}`,
  );
}

function parentDirectory(path: string): string | null {
  const normalized = trimTrailingSeparators(path.replace(/\\/g, "/"));
  if (!normalized) {
    return null;
  }
  if (normalized === "/" || /^[A-Za-z]:\/?$/.test(normalized)) {
    return normalized.endsWith("/") ? normalized : `${normalized}/`;
  }

  const index = normalized.lastIndexOf("/");
  if (index < 0) {
    return null;
  }
  if (index === 0) {
    return "/";
  }
  const parent = normalized.slice(0, index);
  if (/^[A-Za-z]:$/.test(parent)) {
    return `${parent}/`;
  }
  return parent;
}

function joinAbsolute(baseDirectory: string, relativePath: string): string | null {
  const directory = trimTrailingSeparators(baseDirectory.replace(/\\/g, "/"));
  const relative = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!directory) {
    return null;
  }
  return normalizeAbsolutePath(`${directory}/${relative}`);
}

function isHomeRelativePath(value: string): boolean {
  return value === "~" || value.startsWith("~/") || value.startsWith("~\\");
}

function decodeRelativeSource(source: string): string {
  try {
    return decodeURIComponent(source);
  } catch {
    return source;
  }
}

export function resolveMarkdownFileDirectory(input: {
  markdownPath: string;
  workspaceRoot?: string;
}): string | null {
  const markdownPath = input.markdownPath.trim().replace(/\\/g, "/");
  if (!markdownPath || isHomeRelativePath(markdownPath)) {
    return null;
  }

  if (isAbsolutePath(markdownPath)) {
    const absolute = normalizeAbsolutePath(markdownPath);
    return absolute ? parentDirectory(absolute) : null;
  }

  const workspaceRoot = input.workspaceRoot?.trim();
  if (!workspaceRoot || !isAbsolutePath(workspaceRoot)) {
    return null;
  }

  const absoluteMarkdown = joinAbsolute(workspaceRoot, markdownPath);
  return absoluteMarkdown ? parentDirectory(absoluteMarkdown) : null;
}

export function resolveMarkdownPreviewImageSource(input: {
  source: string;
  markdownPath: string;
  workspaceRoot?: string;
}): string | null {
  const source = input.source.trim();
  if (!source) {
    return null;
  }

  if (/^(https?:|data:|blob:)/i.test(source)) {
    return source;
  }

  const path = decodeRelativeSource(localFileSourceToPath(source));
  if (!path) {
    return null;
  }

  if (isHomeRelativePath(path) || isAbsolutePath(path)) {
    return path;
  }

  const directory = resolveMarkdownFileDirectory({
    markdownPath: input.markdownPath,
    workspaceRoot: input.workspaceRoot,
  });
  if (!directory) {
    return path;
  }

  return joinAbsolute(directory, path);
}
