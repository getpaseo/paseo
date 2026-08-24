/**
 * Declarative manifest of the git forges Paseo knows how to present, mirroring
 * provider-manifest.ts. Pure build-time data shared by BOTH the client (icon,
 * brand label, PR↔MR relabel) and the server (registry host-matching, prompt
 * branding). It is NEVER serialized over the wire, so adding a forge here is not
 * a protocol change.
 *
 * Keep this a pure leaf: no imports, no zod, no functions with runtime deps.
 * Behavioural concerns (CLI invocation, host probing, REST adapters) live in the
 * server adapter keyed by {@link ForgeDefinition.id}; this file is only the
 * declarative half.
 */

/**
 * Declarative sign-in recipe for a forge. The client renders install/sign-in
 * hints from this data alone — no per-CLI switch — so a new forge wires its auth
 * UX entirely from the manifest. Behavioural auth (the actual host probe) stays
 * in the server adapter; this is only what the user is told to run.
 */
export interface ForgeSignInCommand {
  /** Binary the user installs, e.g. "gh" — shown in the install-CLI hint. */
  cli: string;
  /** Full sign-in command, e.g. "gh auth login". */
  command: string;
  /**
   * Flag that targets a self-hosted host, e.g. "--hostname". When present and a
   * host is known, the client appends `${command} ${hostnameFlag} ${host}`.
   * Omit when the command already targets the right host on its own.
   */
  hostnameFlag?: string;
}

export interface ForgeDefinition {
  /** Registry id, matches the server adapter and the wire `forge` value. */
  id: string;
  /** Human brand name, e.g. for "Open on GitLab". */
  displayName: string;
  /** Short change-request noun: "PR" for GitHub, "MR" for GitLab. */
  changeRequestAbbrev: string;
  /** Full change-request noun: "pull request" vs "merge request". */
  changeRequestNoun: string;
  /** Prefix before a change-request number: "#" vs "!". */
  changeRequestNumberPrefix: string;
  /** Prefix before an issue number ("#" on every forge so far). */
  issueNumberPrefix: string;
  /** Icon key; the client falls back to a generic git icon for unknown values. */
  iconKind: string;
  /** Sign-in recipe, or null when the forge has no Paseo-driven sign-in. */
  signIn: ForgeSignInCommand | null;
  /**
   * Public cloud hosts this forge owns exactly. A BOUNDED list, never an
   * allowlist for self-hosted detection — self-hosted/Enterprise instances are
   * recognized at runtime by the adapter's host probe, not by this field.
   */
  cloudHosts?: string[];
}

export const FORGE_DEFINITIONS: ForgeDefinition[] = [
  {
    id: "github",
    displayName: "GitHub",
    changeRequestAbbrev: "PR",
    changeRequestNoun: "pull request",
    changeRequestNumberPrefix: "#",
    issueNumberPrefix: "#",
    iconKind: "github",
    signIn: { cli: "gh", command: "gh auth login" },
    cloudHosts: ["github.com", "ssh.github.com"],
  },
  {
    id: "gitlab",
    displayName: "GitLab",
    changeRequestAbbrev: "MR",
    changeRequestNoun: "merge request",
    changeRequestNumberPrefix: "!",
    issueNumberPrefix: "#",
    iconKind: "gitlab",
    signIn: { cli: "glab", command: "glab auth login", hostnameFlag: "--hostname" },
    cloudHosts: ["gitlab.com"],
  },
  {
    id: "gitea",
    displayName: "Gitea",
    changeRequestAbbrev: "PR",
    changeRequestNoun: "pull request",
    changeRequestNumberPrefix: "#",
    issueNumberPrefix: "#",
    iconKind: "gitea",
    signIn: { cli: "tea", command: "tea login add" },
    cloudHosts: ["gitea.com"],
  },
  {
    id: "forgejo",
    displayName: "Forgejo",
    changeRequestAbbrev: "PR",
    changeRequestNoun: "pull request",
    changeRequestNumberPrefix: "#",
    issueNumberPrefix: "#",
    iconKind: "forgejo",
    signIn: { cli: "tea", command: "tea login add" },
  },
  {
    id: "codeberg",
    displayName: "Codeberg",
    changeRequestAbbrev: "PR",
    changeRequestNoun: "pull request",
    changeRequestNumberPrefix: "#",
    issueNumberPrefix: "#",
    iconKind: "codeberg",
    signIn: { cli: "tea", command: "tea login add" },
    cloudHosts: ["codeberg.org"],
  },
];

/** Forge definitions only present in dev builds (none today; mirrors providers). */
export const DEV_FORGE_DEFINITIONS: ForgeDefinition[] = [];

export const FORGE_IDS: string[] = FORGE_DEFINITIONS.map((definition) => definition.id);

export function getForgeDefinition(
  id: string,
  definitions: ForgeDefinition[] = [...FORGE_DEFINITIONS, ...DEV_FORGE_DEFINITIONS],
): ForgeDefinition | null {
  return definitions.find((definition) => definition.id === id) ?? null;
}

/**
 * Resolve a forge definition, synthesizing a neutral one for a forge id the
 * client has never heard of (e.g. a self-hosted forge a newer daemon reports to
 * an older client). The neutral shape renders generic, never GitHub-branded.
 */
export function getForgeDefinitionOrNeutral(id: string): ForgeDefinition {
  return (
    getForgeDefinition(id) ?? {
      id,
      displayName: id,
      changeRequestAbbrev: "PR",
      changeRequestNoun: "pull request",
      changeRequestNumberPrefix: "#",
      issueNumberPrefix: "#",
      iconKind: "git",
      signIn: null,
    }
  );
}
