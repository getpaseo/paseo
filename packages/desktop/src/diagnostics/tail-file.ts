import { readFileSync } from "node:fs";

interface TailFileOptions {
  throwOnReadError?: boolean;
}

export function tailFile(filePath: string, lines = 50, options: TailFileOptions = {}): string {
  try {
    const content = readFileSync(filePath, "utf-8");
    return content.split("\n").filter(Boolean).slice(-lines).join("\n");
  } catch (error) {
    if (options.throwOnReadError && !isMissingFileError(error)) {
      throw error;
    }
    return "";
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
