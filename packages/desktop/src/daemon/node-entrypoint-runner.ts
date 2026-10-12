import { pathToFileURL } from "node:url";
import { initializeEnhancedDaemonHome } from "./enhanced-home.js";

export async function main(): Promise<void> {
  const [argvMode, entryPath, ...args] = process.argv.slice(2);
  if (argvMode !== "bare" && argvMode !== "node-script") {
    throw new Error(`Unsupported node entrypoint argv mode: ${argvMode ?? "<missing>"}`);
  }
  if (!entryPath) {
    throw new Error("Missing node entrypoint path.");
  }
  if (process.env.PASEO_DEEP_LINK_SCHEME === "paseo-enhanced" && process.env.PASEO_HOME) {
    await initializeEnhancedDaemonHome(process.env.PASEO_HOME);
  }

  process.argv =
    argvMode === "bare"
      ? [process.argv[0] ?? "node", ...args]
      : [process.argv[0] ?? "node", entryPath, ...args];
  await import(pathToFileURL(entryPath).href);
}

if (require.main === module) {
  void main().catch((error) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
