import { mkdir, rmdir, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import type { ProjectCreateDirectoryErrorCode } from "@getpaseo/protocol/messages";
import { expandTilde } from "../utils/path.js";
import type { PersistedProjectRecord } from "./workspace-registry.js";

export class ProjectDirectoryRequestError extends Error {
  constructor(
    readonly code: ProjectCreateDirectoryErrorCode,
    message: string,
    readonly directoryPath: string | null = null,
  ) {
    super(message);
    this.name = "ProjectDirectoryRequestError";
  }
}

export interface CreateProjectDirectoryInput {
  parentPath: string;
  name: string;
}

export interface CreateProjectDirectoryResult {
  directoryPath: string;
  project: PersistedProjectRecord;
}

interface ProjectDirectoryFileSystem {
  stat(path: string): Promise<{ isDirectory(): boolean }>;
  mkdir(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
}

interface CreateProjectDirectoryDependencies {
  filesystem?: ProjectDirectoryFileSystem;
  registerProject(directoryPath: string): Promise<PersistedProjectRecord>;
}

const nodeProjectDirectoryFileSystem: ProjectDirectoryFileSystem = {
  stat,
  async mkdir(path) {
    await mkdir(path);
  },
  rmdir,
};

export async function createProjectDirectory(
  input: CreateProjectDirectoryInput,
  dependencies: CreateProjectDirectoryDependencies,
): Promise<CreateProjectDirectoryResult> {
  validateDirectoryName(input.name);

  const requestedParentPath = input.parentPath.trim();
  if (!requestedParentPath) {
    throw new ProjectDirectoryRequestError(
      "parent_directory_not_found",
      "Parent directory is required",
    );
  }
  const parentDirectory = resolve(expandTilde(requestedParentPath));
  const directoryPath = resolve(parentDirectory, input.name);
  if (!isPathInside(parentDirectory, directoryPath)) {
    throw new ProjectDirectoryRequestError(
      "invalid_name",
      "Directory name must resolve inside the selected parent",
    );
  }

  const filesystem = dependencies.filesystem ?? nodeProjectDirectoryFileSystem;
  await requireExistingParent(filesystem, parentDirectory);

  try {
    await filesystem.mkdir(directoryPath);
  } catch (error) {
    throw mapCreateDirectoryError(error, directoryPath);
  }

  try {
    const project = await dependencies.registerProject(directoryPath);
    return { directoryPath, project };
  } catch (registrationError) {
    try {
      await filesystem.rmdir(directoryPath);
    } catch (rollbackError) {
      throw new ProjectDirectoryRequestError(
        "registration_failed",
        `Failed to register project and roll back directory: ${errorMessage(rollbackError)}`,
        directoryPath,
      );
    }
    throw new ProjectDirectoryRequestError(
      "registration_failed",
      `Failed to register project: ${errorMessage(registrationError)}`,
      directoryPath,
    );
  }
}

export function validateDirectoryName(name: string): void {
  if (name.trim().length === 0) {
    throw new ProjectDirectoryRequestError("invalid_name", "Directory name cannot be empty");
  }
  if (name !== name.trim()) {
    throw new ProjectDirectoryRequestError(
      "invalid_name",
      "Directory name cannot start or end with whitespace",
    );
  }
  if (name === "." || name === "..") {
    throw new ProjectDirectoryRequestError("invalid_name", "Directory name cannot be . or ..");
  }
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) {
    throw new ProjectDirectoryRequestError(
      "invalid_name",
      "Directory name must be a single name without path separators",
    );
  }
  if (isAbsolute(name) || win32.isAbsolute(name) || /^[A-Za-z]:/.test(name)) {
    throw new ProjectDirectoryRequestError(
      "invalid_name",
      "Directory name cannot be an absolute path",
    );
  }
}

async function requireExistingParent(
  filesystem: ProjectDirectoryFileSystem,
  parentDirectory: string,
): Promise<void> {
  try {
    const parent = await filesystem.stat(parentDirectory);
    if (parent.isDirectory()) {
      return;
    }
    throw new ProjectDirectoryRequestError(
      "parent_directory_not_found",
      `Parent directory not found: ${parentDirectory}`,
    );
  } catch (error) {
    if (error instanceof ProjectDirectoryRequestError) {
      throw error;
    }
    const code = nodeErrorCode(error);
    if (code === "EACCES" || code === "EPERM") {
      throw new ProjectDirectoryRequestError(
        "permission_denied",
        `Permission denied reading parent directory: ${parentDirectory}`,
      );
    }
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new ProjectDirectoryRequestError(
        "parent_directory_not_found",
        `Parent directory not found: ${parentDirectory}`,
      );
    }
    throw new ProjectDirectoryRequestError(
      "filesystem_error",
      `Failed to inspect parent directory: ${errorMessage(error)}`,
    );
  }
}

function mapCreateDirectoryError(
  error: unknown,
  directoryPath: string,
): ProjectDirectoryRequestError {
  const code = nodeErrorCode(error);
  if (code === "EEXIST") {
    return new ProjectDirectoryRequestError(
      "directory_exists",
      `Directory already exists: ${directoryPath}`,
      directoryPath,
    );
  }
  if (code === "ENOENT" || code === "ENOTDIR") {
    return new ProjectDirectoryRequestError(
      "parent_directory_not_found",
      `Parent directory not found: ${resolve(directoryPath, "..")}`,
      directoryPath,
    );
  }
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
    return new ProjectDirectoryRequestError(
      "permission_denied",
      `Permission denied creating directory: ${directoryPath}`,
      directoryPath,
    );
  }
  return new ProjectDirectoryRequestError(
    "filesystem_error",
    `Failed to create directory: ${errorMessage(error)}`,
    directoryPath,
  );
}

function isPathInside(parentDirectory: string, directoryPath: string): boolean {
  const relativePath = relative(parentDirectory, directoryPath);
  return (
    relativePath.length > 0 &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

function nodeErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return null;
  }
  return typeof error.code === "string" ? error.code : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
