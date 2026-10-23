import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const originalRoot =
  "file:///Applications/Paseo.app/Contents/Resources/app.asar/node_modules/@getpaseo/server/dist/server/server/agent/";
const patchRoot = process.env.PASEO_MEMORY_PATCH_ROOT;
if (!patchRoot)
  throw new Error(
    "Set PASEO_MEMORY_PATCH_ROOT to the checkout packages/server/dist/server/server/agent directory",
  );
const replacements = new Map(
  ["plugin-provider", "timeline-projection"].map((name) => [
    originalRoot + name + ".js",
    pathToFileURL(resolve(patchRoot, name + ".js")).href,
  ]),
);
const originals = new Map([...replacements].map(([original, patch]) => [patch, original]));
registerHooks({
  resolve(specifier, context, nextResolve) {
    const parentURL = originals.get(context.parentURL) ?? context.parentURL;
    const result = nextResolve(specifier, { ...context, parentURL });
    return replacements.has(result.url) ? { ...result, url: replacements.get(result.url) } : result;
  },
});
