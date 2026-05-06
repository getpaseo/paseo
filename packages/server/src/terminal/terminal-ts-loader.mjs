import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, nextResolve) {
  if (
    context.parentURL?.startsWith("file:") &&
    specifier.startsWith(".") &&
    specifier.endsWith(".js")
  ) {
    const candidateUrl = new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL);
    if (existsSync(fileURLToPath(candidateUrl))) {
      return {
        url: candidateUrl.href,
        shortCircuit: true,
      };
    }
  }

  return nextResolve(specifier, context);
}
