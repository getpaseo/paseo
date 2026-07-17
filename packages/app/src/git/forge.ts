/**
 * Forge-neutral presentation layer for the git-hosting UI, derived from the
 * shared forge manifest.
 *
 * The daemon resolves which forge backs a workspace and reports it on the wire
 * (`CheckoutPrStatusResponse.payload.forge`). The model keeps the `PullRequest`
 * noun in code and types; the PR↔MR relabel, the number prefix, the brand mark,
 * and the icon are a UI concern driven by the manifest entry for that id. An
 * unknown/absent forge (e.g. a self-hosted forge a newer daemon reports to an
 * older client) renders neutrally — never GitHub-branded. A null/empty forge
 * still maps to GitHub so old daemons (which never send a forge) render exactly
 * as before.
 */
import { FORGE_DEFINITIONS, getForgeDefinitionOrNeutral } from "@getpaseo/protocol/forge-manifest";
import { normalizeHost, parseGitRemoteLocation } from "@getpaseo/protocol/git-remote";
import type { ForgeAuthState } from "@getpaseo/protocol/messages";
import {
  buildForgeBlobUrl,
  buildForgeBranchTreeUrl,
  hasForgeWebUrls,
  type ForgeBlobUrlInput,
  type ForgeBranchTreeUrlInput,
} from "@/git/forge-url";

/**
 * A forge id. Open by design: any id the daemon reports is valid, and the
 * manifest drives presentation with a neutral fallback for unknown ids. Kept as
 * a named alias to document intent at call sites.
 */
export type Forge = string;

export function normalizeForge(raw: string | null | undefined): string {
  return raw && raw.length > 0 ? raw : "github";
}

export function parseForgeAuthState(value: unknown): ForgeAuthState | undefined {
  switch (value) {
    case "authenticated":
    case "unauthenticated":
    case "cli_missing":
    case "no_remote":
    case "error":
      return value;
    default:
      return undefined;
  }
}

export function forgeFromRemoteUrl(remoteUrl: string | null | undefined): string | null {
  if (!remoteUrl) {
    return null;
  }
  const host = parseGitRemoteLocation(remoteUrl)?.host;
  if (!host) {
    return null;
  }
  const normalized = normalizeHost(host);
  for (const definition of FORGE_DEFINITIONS) {
    if (definition.cloudHosts?.some((cloudHost) => normalizeHost(cloudHost) === normalized)) {
      return definition.id;
    }
  }
  return null;
}

export interface ForgePresentation {
  forge: string;
  /** Icon key; render sites fall back to a generic git icon for unknown values. */
  icon: string;
  /** Human brand name, e.g. for "Open on GitLab". */
  brandLabel: string;
  /** Short change-request noun: "PR" for GitHub, "MR" for GitLab. */
  changeRequestAbbrev: string;
  /** Full change-request noun: "pull request" for GitHub, "merge request" for GitLab. */
  changeRequestNoun: string;
  /** Prefix the forge puts before a change-request number: "#" vs "!". */
  numberPrefix: string;
  /** Prefix the forge puts before an issue number ("#" on every forge so far). */
  issueNumberPrefix: string;
  /** Auth CLI binary for the install hint, or null for a forge with no Paseo-driven sign-in. */
  signInCli: string | null;
  /**
   * i18next context selecting the change-request vocabulary family for any key
   * that carries an `_mr` variant: `t(key, { context: changeRequestContext })`
   * resolves `key_mr` for the merge-request family and falls back to the base
   * (pull-request) string for undefined or unknown families.
   */
  changeRequestContext: "mr" | undefined;
  buildBlobUrl: ((input: ForgeBlobUrlInput) => string | null) | null;
  buildBranchTreeUrl: ((input: ForgeBranchTreeUrlInput) => string | null) | null;
}

export function getForgePresentation(forge: string): ForgePresentation {
  const definition = getForgeDefinitionOrNeutral(forge);
  const isMergeRequest = definition.changeRequestAbbrev === "MR";
  const hasWebUrls = hasForgeWebUrls(definition.id);
  return {
    forge: definition.id,
    icon: definition.iconKind,
    brandLabel: definition.displayName,
    changeRequestAbbrev: definition.changeRequestAbbrev,
    changeRequestNoun: definition.changeRequestNoun,
    numberPrefix: definition.changeRequestNumberPrefix,
    issueNumberPrefix: definition.issueNumberPrefix,
    signInCli: definition.signIn?.cli ?? null,
    changeRequestContext: isMergeRequest ? "mr" : undefined,
    buildBlobUrl: hasWebUrls ? (input) => buildForgeBlobUrl(definition.id, input) : null,
    buildBranchTreeUrl: hasWebUrls
      ? (input) => buildForgeBranchTreeUrl(definition.id, input)
      : null,
  };
}

export function buildForgeSignInCommand(forge: string, host: string | null): string | null {
  const signIn = getForgeDefinitionOrNeutral(forge).signIn;
  if (!signIn) {
    return null;
  }
  // A forge that needs a --hostname only gets it when a host is known; forges
  // whose command already targets the right API host (e.g. github's plain
  // `gh auth login`, which must NOT receive ssh.github.com) omit hostnameFlag.
  if (signIn.hostnameFlag && host) {
    return `${signIn.command} ${signIn.hostnameFlag} ${host}`;
  }
  return signIn.command;
}
