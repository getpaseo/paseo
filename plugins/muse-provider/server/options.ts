import { z } from "zod";
import { MuseError } from "./errors.js";

const optionsSchema = z
  .object({
    sandbox: z
      .object({
        enabled: z.boolean().default(false),
        network: z.enum(["proxy-only", "restricted", "enabled"]).default("proxy-only"),
      })
      .strict()
      .prefault({}),
    trustWorkspace: z.boolean().default(true),
  })
  .strict();

export function serveArgs(providerOptions: unknown): string[] {
  const parsed = optionsSchema.safeParse(providerOptions === undefined ? {} : providerOptions);
  if (!parsed.success) {
    const errors = parsed.error.issues
      .map((issue) => `${["providerOptions", ...issue.path].join(".")}: ${issue.message}`)
      .join("; ");
    throw new MuseError("invalidProviderOptions", `Invalid Muse providerOptions: ${errors}`);
  }
  const { sandbox, trustWorkspace } = parsed.data;
  return [
    "--sandbox-network",
    sandbox.network,
    ...(sandbox.enabled ? [] : ["--disable-sandbox"]),
    ...(trustWorkspace ? ["--trust-workspace"] : []),
  ];
}
