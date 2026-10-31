import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { writeFileAtomic } from "../../../../atomic-file.js";

const PACKAGE = JSON.stringify({
  name: "paseo-managed-bridge",
  private: true,
  type: "module",
  exports: { "./server": "./server.js" },
});

export function openCodeConfigDirectory(env: NodeJS.ProcessEnv): string {
  return (
    env.OPENCODE_CONFIG_DIR ??
    path.join(env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config"), "opencode")
  );
}

export async function hasManagedBridge(configDirectory: string): Promise<boolean> {
  const directory = path.join(configDirectory, "plugins", "paseo-managed-bridge");
  const [manifest, artifact] = await Promise.all([
    readFile(path.join(directory, "package.json"), "utf8").catch(() => ""),
    readFile(path.join(directory, "server.js")).catch(() => undefined),
  ]);
  return isManagedPackage(manifest) && Boolean(artifact?.length);
}

export async function provisionLocalBridge(input: {
  configDirectory: string;
  artifact: string;
}): Promise<void> {
  const directory = path.join(input.configDirectory, "plugins", "paseo-managed-bridge");
  await mkdir(path.dirname(directory), { recursive: true });
  let created = false;
  try {
    await mkdir(directory);
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const manifest = path.join(directory, "package.json");
  if (created) await writeFileAtomic(manifest, PACKAGE);
  else if (!isManagedPackage(await readManagedManifest(manifest)))
    throw new Error(`Cannot install OpenCode bridge: ${directory} is not managed by Paseo`);
  const artifact = await readFile(input.artifact);
  const state = await readFile(path.join(path.dirname(input.artifact), "state.mjs"));
  const stateTarget = path.join(directory, "state.mjs");
  const existingState = await readFile(stateTarget).catch(() => undefined);
  if (!existingState) await writeFileAtomic(stateTarget, state);
  else if (!existingState.equals(state))
    throw new Error(`Cannot update OpenCode bridge state module at ${stateTarget}`);
  const target = path.join(directory, "server.js");
  const existing = await readFile(target).catch(() => undefined);
  if (!existing?.equals(artifact)) await writeFileAtomic(target, artifact);
}

function isManagedPackage(content: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return false;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const manifest = value as Record<string, unknown>;
  if (!manifest.exports || typeof manifest.exports !== "object" || Array.isArray(manifest.exports))
    return false;
  const exports = manifest.exports as Record<string, unknown>;
  return (
    manifest.name === "paseo-managed-bridge" &&
    manifest.private === true &&
    manifest.type === "module" &&
    exports["./server"] === "./server.js"
  );
}

async function readManagedManifest(file: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      return await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await delay(25);
    }
  }
  return "";
}
