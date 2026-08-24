import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

const CONVENTIONAL_SERVICE_SCRIPTS = ["dev", "start", "serve", "preview"] as const;

export interface PackageServiceSuggestion {
  scriptName: string;
  command: string;
}

async function fileExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function resolvePackageCommand(cwd: string, scriptName: string): Promise<string> {
  if (await fileExists(join(cwd, "pnpm-lock.yaml"))) return `pnpm run ${scriptName}`;
  if (await fileExists(join(cwd, "yarn.lock"))) return `yarn ${scriptName}`;
  if (await fileExists(join(cwd, "bun.lockb"))) return `bun run ${scriptName}`;
  return `npm run ${scriptName}`;
}

export async function listPackageServiceSuggestions(
  cwd: string,
): Promise<PackageServiceSuggestion[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
  } catch {
    return [];
  }
  const scripts =
    parsed && typeof parsed === "object" && "scripts" in parsed
      ? (parsed as { scripts?: unknown }).scripts
      : null;
  if (!scripts || typeof scripts !== "object") return [];

  const suggestions: PackageServiceSuggestion[] = [];
  for (const scriptName of CONVENTIONAL_SERVICE_SCRIPTS) {
    if (typeof (scripts as Record<string, unknown>)[scriptName] !== "string") continue;
    suggestions.push({
      scriptName,
      command: await resolvePackageCommand(cwd, scriptName),
    });
  }
  return suggestions;
}
