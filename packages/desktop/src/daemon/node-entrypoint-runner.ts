import { pathToFileURL } from "node:url";

export async function main(): Promise<void> {
  const [argvMode, entryPath, ...args] = process.argv.slice(2);
  if (argvMode !== "bare" && argvMode !== "node-script") {
    throw new Error(`Unsupported node entrypoint argv mode: ${argvMode ?? "<missing>"}`);
  }
  if (!entryPath) {
    throw new Error("Missing node entrypoint path.");
  }

  process.argv =
    argvMode === "bare"
      ? [process.argv[0] ?? "node", ...args]
      : [process.argv[0] ?? "node", entryPath, ...args];
  await import(pathToFileURL(entryPath).href);
}

// Auto-invoke only when the runner was spawned in production mode — the
// desktop main process always passes "bare" or "node-script" as argv[2].
// Vitest / vitest-import paths never have that, so the test file can import
// `{ main }` without running the body. This is more reliable than
// `require.main === module`, which can be fooled by asar/fork spawn modes.
const productionArgvMode = process.argv[2];
if (productionArgvMode === "bare" || productionArgvMode === "node-script") {
  void main().catch((error) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
