import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export interface WorkerEntrypoint {
  entrypoint: string | URL;
  eval: boolean;
}

export function resolveWorkerEntrypoint(workerUrl: URL): WorkerEntrypoint {
  if (!workerUrl.pathname.endsWith(".ts")) return { entrypoint: workerUrl, eval: false };
  const tsxUrl = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm/api")).href;
  return {
    entrypoint: `import(${JSON.stringify(tsxUrl)}).then(({ register }) => { register(); return import(${JSON.stringify(workerUrl.href)}); });`,
    eval: true,
  };
}
