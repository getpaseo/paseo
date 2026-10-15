import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

interface ExternalUrlOwner {
  open(url: string): Promise<void>;
}

interface DirectoryOwner {
  openPath(path: string): Promise<string>;
}

export function createDirectoryOpener(owner: DirectoryOwner) {
  return async (candidate: unknown): Promise<boolean> => {
    if (typeof candidate !== "string") {
      throw new Error("Directory path must be a string.");
    }
    const directory =
      candidate === "~" || candidate.startsWith("~/")
        ? path.join(os.homedir(), candidate.slice(2))
        : candidate;
    if (!path.isAbsolute(directory)) {
      throw new Error("Directory path must be an absolute local path.");
    }
    try {
      if (!(await stat(directory)).isDirectory()) return false;
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "ENOTDIR")
      )
        return false;
      throw error;
    }
    const errorMessage = await owner.openPath(directory);
    if (errorMessage) throw new Error(errorMessage);
    return true;
  };
}

const EXTERNAL_PROTOCOLS = new Set(["http:", "https:"]);

const asExternalUrl = (input: unknown): URL | undefined => {
  if (typeof input !== "string" || !URL.canParse(input)) return undefined;
  const candidate = new URL(input);
  return EXTERNAL_PROTOCOLS.has(candidate.protocol) ? candidate : undefined;
};

export function createExternalUrlOpener(owner: ExternalUrlOwner) {
  return async (candidate: unknown): Promise<void> => {
    const url = asExternalUrl(candidate);
    if (url === undefined) {
      throw new Error("Only HTTP(S) URLs can open externally.");
    }
    return owner.open(url.href);
  };
}
