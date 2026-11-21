import type { PluginHookContext } from "@getpaseo/plugin/server";

/**
 * The environment the user configured for a provider.
 *
 * The daemon holds it as the provider's runtime settings and merges it into
 * the child process. The hook that injects the ZCode key runs before that
 * merge, so the injected key would replace a key the user configured.
 *
 * The provider's entry carries the raw configuration, and the `env` it holds
 * is the one the daemon merges into the child process.
 */
export async function readProviderEnv(
  context: Pick<PluginHookContext, "paseo">,
  providerId: string,
): Promise<Record<string, string> | undefined> {
  try {
    const { config } = await context.paseo.config.get();
    const provider = config.providers?.[providerId] as { env?: Record<string, string> } | undefined;
    return provider?.env;
  } catch {
    // A daemon that does not answer the config RPC leaves the configured key
    // invisible. The ZCode key is still better than no key at all.
    return undefined;
  }
}
