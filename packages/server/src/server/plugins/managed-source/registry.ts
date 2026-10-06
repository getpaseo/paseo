import {
  PublishedPluginDetailSchema,
  type PluginRegistries,
  type PluginRegistryIdentity,
} from "@getpaseo/protocol/plugin-registry";
import type { PluginUpdateTarget } from "@getpaseo/protocol/messages";

export interface RegistryOptions {
  defaultUrl?: string;
  registries?: PluginRegistries;
}
export async function resolveRegistryPlugin(
  identity: PluginRegistryIdentity,
  options: RegistryOptions,
  install: boolean,
) {
  const base = new URL(identity.url);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password)
    throw new Error("Registry base must be an HTTP(S) URL without credentials");
  const authorization = options.registries?.[base.host]?.authorization;
  if (
    authorization &&
    base.protocol !== "https:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)
  )
    throw new Error("Registry credentials require HTTPS");
  const headers: Record<string, string> = {};
  if (authorization) headers.Authorization = authorization;
  if (install) headers["X-Paseo-Install"] = "1";
  const url = `${identity.url.replace(/\/+$/, "")}/plugins/${identity.id}.json`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
  } catch (cause) {
    const guidance = install
      ? `Plugin ${identity.id} was not installed. Retry or use an explicit npm: or github: source.`
      : `Could not check updates for ${identity.id}. Retry later.`;
    throw new Error(`Could not reach plugin registry ${url}. ${guidance}`, { cause });
  }
  if (response.status === 404) {
    const guidance = install
      ? `If you intended a local directory, use ./${identity.id}. If you intended a GitHub source, use git:${identity.id}, or a full Git URL for another Git host.`
      : "Check that the installed plugin is still published in this registry before updating.";
    throw new Error(`Plugin ${identity.id} was not found in registry ${base.host}. ${guidance}`);
  }
  if (!response.ok)
    throw new Error(`Registry ${base.host} returned ${response.status} for ${identity.id}`);
  const plugin = PublishedPluginDetailSchema.parse(await response.json());
  if (plugin.id !== identity.id) throw new Error("Registry returned a different plugin ID");
  const artifact = plugin.artifact;
  const target: PluginUpdateTarget =
    artifact.kind === "npm"
      ? {
          kind: "npm",
          version: artifact.version,
          resolved: artifact.resolved,
          integrity: artifact.integrity,
        }
      : { kind: "git", commit: artifact.commit };
  const input =
    artifact.kind === "npm"
      ? { source: `npm:${artifact.package}@${artifact.version}` }
      : { source: `git:${artifact.remote}`, ref: artifact.commit, pluginPath: artifact.pluginPath };
  return { input, target, artifact };
}
