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

// Auto-invoke only when launched as the script (not when imported by tests).
// `require.main === module` is the CommonJS-compatible "is this the entry"
// check; `import.meta` would also work but the desktop tsconfig still emits
// CJS so we can't use it here.
declare const require: NodeJS.Require;
declare const module: NodeJS.Module;
if (typeof require !== "undefined" && require.main === module) {
  void main().catch((error) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
