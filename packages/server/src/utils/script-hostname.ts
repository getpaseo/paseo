import { slugify } from "./worktree.js";

const MAX_DNS_LABEL_LENGTH = 63;

interface BuildScriptHostnameOptions {
  projectSlug: string;
  branchName: string | null;
  scriptName: string;
}

interface BuildPublicScriptHostnameOptions extends BuildScriptHostnameOptions {
  publicBaseUrl: string;
}

function toHostnameLabel(value: string): string {
  return slugify(value) || "untitled";
}

function capDnsLabel(label: string): string {
  if (label.length <= MAX_DNS_LABEL_LENGTH) {
    return label;
  }
  return label.slice(0, MAX_DNS_LABEL_LENGTH).replace(/-+$/g, "") || "untitled";
}

function toPublicServiceLabel({
  projectSlug,
  branchName,
  scriptName,
}: BuildScriptHostnameOptions): string {
  const labels = [toHostnameLabel(scriptName)];
  const isDefaultBranch = branchName === null || branchName === "main" || branchName === "master";
  if (!isDefaultBranch) {
    labels.push(toHostnameLabel(branchName));
  }
  labels.push(toHostnameLabel(projectSlug));

  // Public URLs must keep script/branch/project in one label. The local
  // script.branch.project.localhost shape would require multi-level wildcard
  // DNS/certificates for arbitrary branch names, while a single label works with
  // normal `*.base-domain` DNS and wildcard TLS. Cap it to the DNS 63-octet
  // label limit so long branch/project/script names still produce resolvable URLs.
  return capDnsLabel(labels.join("--"));
}

export function buildScriptHostname({
  projectSlug,
  branchName,
  scriptName,
}: BuildScriptHostnameOptions): string {
  const serviceHostnameLabel = toHostnameLabel(scriptName);
  const projectHostnameLabel = toHostnameLabel(projectSlug);
  const isDefaultBranch = branchName === null || branchName === "main" || branchName === "master";

  if (isDefaultBranch) {
    return `${serviceHostnameLabel}.${projectHostnameLabel}.localhost`;
  }

  return `${serviceHostnameLabel}.${toHostnameLabel(branchName)}.${projectHostnameLabel}.localhost`;
}

export function buildPublicScriptHostname({
  publicBaseUrl,
  ...script
}: BuildPublicScriptHostnameOptions): string {
  const base = new URL(publicBaseUrl);
  return `${toPublicServiceLabel(script)}.${base.hostname}`;
}

export function buildPublicScriptProxyUrl(options: BuildPublicScriptHostnameOptions): string {
  const base = new URL(options.publicBaseUrl);
  const hostname = buildPublicScriptHostname(options);
  const port = base.port ? `:${base.port}` : "";
  return `${base.protocol}//${hostname}${port}`;
}
