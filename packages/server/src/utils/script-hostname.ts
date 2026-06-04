import {
  buildLocalServiceHostname,
  buildPublicServiceHostname,
  buildPublicServiceProxyUrl,
} from "../server/service-proxy.js";

// Compatibility boundary for older tests/imports; new service proxy code owns hostname rules.

interface BuildScriptHostnameOptions {
  projectSlug: string;
  branchName: string | null;
  scriptName: string;
}

interface BuildPublicScriptHostnameOptions extends BuildScriptHostnameOptions {
  publicBaseUrl: string;
}

export function buildScriptHostname({
  projectSlug,
  branchName,
  scriptName,
}: BuildScriptHostnameOptions): string {
  return buildLocalServiceHostname({ projectSlug, branchName, scriptName });
}

export function buildPublicScriptHostname({
  publicBaseUrl,
  ...script
}: BuildPublicScriptHostnameOptions): string {
  return buildPublicServiceHostname({ publicBaseUrl, ...script });
}

export function buildPublicScriptProxyUrl(options: BuildPublicScriptHostnameOptions): string {
  return buildPublicServiceProxyUrl(options);
}
