import { FORGE_DEFINITIONS } from "@getpaseo/protocol/forge-manifest";
import {
  isGitHubHost,
  normalizeHost,
  parseGitRemoteLocation,
  type GitRemoteLocation,
} from "@getpaseo/protocol/git-remote";
import type { ProjectDescriptor, WorkspaceDescriptor } from "@/stores/session-store";

/** A host-local project identity. Keep this separate from daemon projectKey. */
export interface ProjectLinkPlacementRef {
  serverId: string;
  projectId: string;
}

/**
 * The stable portion stored for a device-local link. It intentionally excludes
 * the original remote URL so credentials and transport details are never persisted.
 */
export interface LocalProjectLinkIdentity {
  repository: string;
  subdirectory: string;
}

export interface ProjectGitIdentity extends LocalProjectLinkIdentity {
  /** Safe display form reconstructed from the parsed Git remote. */
  remoteDisplay: string;
}

export interface LocalProjectLink {
  id: string;
  members: ProjectLinkPlacementRef[];
  identity: LocalProjectLinkIdentity;
}

export interface ProjectLinkPlacement extends ProjectLinkPlacementRef {
  serverName: string;
  projectName: string;
  projectRootPath: string;
  projectKey: string | null;
  identity: ProjectGitIdentity | null;
}

export interface ProjectLinkHostSnapshot {
  serverId: string;
  serverName: string;
  projects: Iterable<ProjectDescriptor>;
  workspaces: Iterable<WorkspaceDescriptor>;
}

export interface ProjectLinkSuggestion {
  identity: LocalProjectLinkIdentity;
  placements: ProjectLinkPlacement[];
}

export type ProjectLinkGroupingOverride = { kind: "linked"; linkId: string } | { kind: "blocked" };

export function projectLinkPlacementKey(placement: ProjectLinkPlacementRef): string {
  return JSON.stringify([placement.serverId, placement.projectId]);
}

export function localProjectLinkViewKey(linkId: string): string {
  return JSON.stringify(["local-project-link", linkId]);
}

export function toLocalProjectLinkIdentity(identity: ProjectGitIdentity): LocalProjectLinkIdentity {
  return {
    repository: canonicalProjectRepository(identity.repository),
    subdirectory: identity.subdirectory,
  };
}

export function sameLocalProjectLinkIdentity(
  left: LocalProjectLinkIdentity,
  right: LocalProjectLinkIdentity,
): boolean {
  return (
    canonicalProjectRepository(left.repository) === canonicalProjectRepository(right.repository) &&
    left.subdirectory === right.subdirectory
  );
}

/**
 * Derive a conservative identity from the latest workspace projection. A project is linkable
 * only when the client can prove both its normalized Git remote and selected subdirectory.
 */
export function resolveProjectGitIdentity(input: {
  project: ProjectDescriptor;
  workspaces: Iterable<WorkspaceDescriptor>;
}): ProjectGitIdentity | null {
  let resolved: ProjectGitIdentity | null = null;
  let sawIdentity = false;

  for (const workspace of input.workspaces) {
    if (workspace.projectId !== input.project.projectId) continue;
    const checkout = workspace.project?.checkout;
    let identityRoot: string | null = null;
    if (checkout?.isGit) {
      identityRoot = checkout.isPaseoOwnedWorktree ? checkout.mainRepoRoot : checkout.worktreeRoot;
    }
    const remoteUrl = workspace.gitRuntime?.remoteUrl;
    if (!identityRoot || !remoteUrl) continue;

    const identity = deriveProjectGitIdentity({
      projectRootPath: input.project.projectRootPath,
      worktreeRoot: identityRoot,
      remoteUrl,
    });
    if (!identity) continue;

    sawIdentity = true;
    if (resolved && !sameLocalProjectLinkIdentity(resolved, identity)) {
      // Contradictory workspace snapshots are not proof of an identity.
      return null;
    }
    resolved = identity;
  }

  return sawIdentity ? resolved : null;
}

export function deriveProjectGitIdentity(input: {
  projectRootPath: string;
  worktreeRoot: string;
  remoteUrl: string;
}): ProjectGitIdentity | null {
  const remote = parseGitRemoteLocation(input.remoteUrl);
  if (!remote) return null;

  const subdirectory = relativeProjectPath(input.worktreeRoot, input.projectRootPath);
  if (subdirectory === null) return null;

  const repositoryAuthority = projectRepositoryAuthority(remote);
  const displayAuthority = remote.port ? `${remote.host}:${remote.port}` : remote.host;
  const path = isGitHubHost(remote.host) ? remote.path.toLowerCase() : remote.path;
  return {
    repository: `${repositoryAuthority}/${path}`,
    remoteDisplay: `${displayAuthority}/${path}`,
    subdirectory,
  };
}

export function buildProjectLinkPlacements(input: {
  hosts: Iterable<ProjectLinkHostSnapshot>;
}): ProjectLinkPlacement[] {
  const placements: ProjectLinkPlacement[] = [];
  for (const host of input.hosts) {
    const workspaces = Array.from(host.workspaces);
    for (const project of host.projects) {
      placements.push({
        serverId: host.serverId,
        serverName: host.serverName,
        projectId: project.projectId,
        projectName: project.projectCustomName ?? project.projectDisplayName,
        projectRootPath: project.projectRootPath,
        projectKey: project.projectKey ?? null,
        identity: resolveProjectGitIdentity({ project, workspaces }),
      });
    }
  }
  return placements.sort(compareProjectLinkPlacements);
}

/**
 * Exact, cross-host matches worth surfacing to the user. Existing daemon grouping is not
 * repeated here. When one host has multiple matching clones, each cross-host pair remains a
 * deliberate manual choice instead of silently choosing a clone.
 */
export function buildProjectLinkSuggestions(input: {
  placements: Iterable<ProjectLinkPlacement>;
  links: Iterable<LocalProjectLink>;
}): ProjectLinkSuggestion[] {
  const allPlacements = Array.from(input.placements);
  const links = Array.from(input.links);
  const placementsByKey = new Map(
    allPlacements.map((placement) => [projectLinkPlacementKey(placement), placement]),
  );
  const linkedPlacementKeys = collectLinkedPlacementKeys(links);
  const validLinksByIdentity = groupValidLocalLinks(links, placementsByKey);
  const collector = createProjectLinkSuggestionCollector();

  // A later host can join an existing device-local link. Keep the existing members visible in
  // the confirmation card so the user sees the group that will result, not merely one anchor.
  addExistingLinkSuggestions({
    links: Array.from(validLinksByIdentity.values()).flat(),
    allPlacements,
    placementsByKey,
    linkedPlacementKeys,
    addSuggestion: collector.add,
  });
  addExistingLinkMergeSuggestions({
    linksByIdentity: validLinksByIdentity,
    placementsByKey,
    addSuggestion: collector.add,
  });

  for (const [identityKey, placements] of groupUnlinkedPlacementsByIdentity({
    placements: allPlacements,
    linkedPlacementKeys,
  })) {
    if (validLinksByIdentity.has(identityKey)) continue;
    addUnlinkedProjectLinkSuggestions({
      placements,
      allPlacements,
      addSuggestion: collector.add,
    });
  }

  return collector.suggestions.sort(compareProjectLinkSuggestions);
}

interface ProjectLinkSuggestionCollector {
  suggestions: ProjectLinkSuggestion[];
  add: (
    identity: LocalProjectLinkIdentity,
    candidatePlacements: readonly ProjectLinkPlacement[],
  ) => void;
}

function createProjectLinkSuggestionCollector(): ProjectLinkSuggestionCollector {
  const suggestions: ProjectLinkSuggestion[] = [];
  const suggestionKeys = new Set<string>();
  return {
    suggestions,
    add(identity, candidatePlacements) {
      const placements = [...candidatePlacements].sort(compareProjectLinkPlacements);
      const key = JSON.stringify([
        projectLinkIdentityKey(identity),
        placements.map(projectLinkPlacementKey),
      ]);
      if (suggestionKeys.has(key)) return;
      suggestionKeys.add(key);
      suggestions.push({ identity, placements });
    },
  };
}

function collectLinkedPlacementKeys(links: readonly LocalProjectLink[]): Set<string> {
  const keys = new Set<string>();
  for (const link of links) {
    for (const member of link.members) keys.add(projectLinkPlacementKey(member));
  }
  return keys;
}

function groupValidLocalLinks(
  links: readonly LocalProjectLink[],
  placementsByKey: ReadonlyMap<string, ProjectLinkPlacement>,
): Map<string, LocalProjectLink[]> {
  const linksByIdentity = new Map<string, LocalProjectLink[]>();
  for (const link of links) {
    if (!isValidLocalProjectLink(link, placementsByKey)) continue;
    const identityKey = projectLinkIdentityKey(link.identity);
    const matchingLinks = linksByIdentity.get(identityKey);
    if (matchingLinks) {
      matchingLinks.push(link);
    } else {
      linksByIdentity.set(identityKey, [link]);
    }
  }
  return linksByIdentity;
}

function addExistingLinkSuggestions(input: {
  links: readonly LocalProjectLink[];
  allPlacements: readonly ProjectLinkPlacement[];
  placementsByKey: ReadonlyMap<string, ProjectLinkPlacement>;
  linkedPlacementKeys: ReadonlySet<string>;
  addSuggestion: ProjectLinkSuggestionCollector["add"];
}): void {
  for (const link of input.links) {
    const linkedPlacements = getLinkPlacements(link, input.placementsByKey);
    const linkedServerIds = new Set(linkedPlacements.map((placement) => placement.serverId));
    for (const candidate of input.allPlacements) {
      if (
        !canJoinExistingLocalLink({
          link,
          candidate,
          linkedServerIds,
          linkedPlacementKeys: input.linkedPlacementKeys,
        })
      ) {
        continue;
      }
      input.addSuggestion(link.identity, [...linkedPlacements, candidate]);
    }
  }
}

function addExistingLinkMergeSuggestions(input: {
  linksByIdentity: ReadonlyMap<string, readonly LocalProjectLink[]>;
  placementsByKey: ReadonlyMap<string, ProjectLinkPlacement>;
  addSuggestion: ProjectLinkSuggestionCollector["add"];
}): void {
  for (const links of input.linksByIdentity.values()) {
    if (links.length < 2) continue;
    const placements = links.flatMap((link) => getLinkPlacements(link, input.placementsByKey));
    if (!hasOnePlacementPerHost(placements)) continue;
    const identity = links[0]?.identity;
    if (!identity) continue;
    input.addSuggestion(identity, placements);
  }
}

function getLinkPlacements(
  link: LocalProjectLink,
  placementsByKey: ReadonlyMap<string, ProjectLinkPlacement>,
): ProjectLinkPlacement[] {
  return link.members.flatMap((member) => {
    const placement = placementsByKey.get(projectLinkPlacementKey(member));
    return placement ? [placement] : [];
  });
}

function canJoinExistingLocalLink(input: {
  link: LocalProjectLink;
  candidate: ProjectLinkPlacement;
  linkedServerIds: ReadonlySet<string>;
  linkedPlacementKeys: ReadonlySet<string>;
}): boolean {
  if (input.linkedPlacementKeys.has(projectLinkPlacementKey(input.candidate))) return false;
  if (input.linkedServerIds.has(input.candidate.serverId)) return false;
  if (!input.candidate.identity) return false;
  return sameLocalProjectLinkIdentity(input.link.identity, input.candidate.identity);
}

function groupUnlinkedPlacementsByIdentity(input: {
  placements: readonly ProjectLinkPlacement[];
  linkedPlacementKeys: ReadonlySet<string>;
}): Map<string, ProjectLinkPlacement[]> {
  const byIdentity = new Map<string, ProjectLinkPlacement[]>();
  for (const placement of input.placements) {
    if (!placement.identity || input.linkedPlacementKeys.has(projectLinkPlacementKey(placement))) {
      continue;
    }
    const identityKey = projectLinkIdentityKey(placement.identity);
    const matches = byIdentity.get(identityKey);
    if (matches) {
      matches.push(placement);
    } else {
      byIdentity.set(identityKey, [placement]);
    }
  }
  return byIdentity;
}

function addUnlinkedProjectLinkSuggestions(input: {
  placements: readonly ProjectLinkPlacement[];
  allPlacements: readonly ProjectLinkPlacement[];
  addSuggestion: ProjectLinkSuggestionCollector["add"];
}): void {
  if (input.placements.length < 2) return;
  if (hasOnePlacementPerHost(input.placements)) {
    addDistinctHostSuggestion(input);
    return;
  }
  addAmbiguousHostPairSuggestions(input);
}

function hasOnePlacementPerHost(placements: readonly ProjectLinkPlacement[]): boolean {
  return new Set(placements.map((placement) => placement.serverId)).size === placements.length;
}

function addDistinctHostSuggestion(input: {
  placements: readonly ProjectLinkPlacement[];
  allPlacements: readonly ProjectLinkPlacement[];
  addSuggestion: ProjectLinkSuggestionCollector["add"];
}): void {
  if (allPlacementsAreAutomaticallyGrouped(input.placements, input.allPlacements)) return;
  const identity = input.placements[0]?.identity;
  if (!identity) return;
  input.addSuggestion(toLocalProjectLinkIdentity(identity), input.placements);
}

function allPlacementsAreAutomaticallyGrouped(
  placements: readonly ProjectLinkPlacement[],
  allPlacements: readonly ProjectLinkPlacement[],
): boolean {
  const projectKey = placements[0]?.projectKey;
  if (!projectKey || !placements.every((placement) => placement.projectKey === projectKey)) {
    return false;
  }
  return placements.every(
    (placement) =>
      allPlacements.filter(
        (candidate) =>
          candidate.serverId === placement.serverId && candidate.projectKey === projectKey,
      ).length === 1,
  );
}

function addAmbiguousHostPairSuggestions(input: {
  placements: readonly ProjectLinkPlacement[];
  allPlacements: readonly ProjectLinkPlacement[];
  addSuggestion: ProjectLinkSuggestionCollector["add"];
}): void {
  const sortedPlacements = [...input.placements].sort(compareProjectLinkPlacements);
  for (let leftIndex = 0; leftIndex < sortedPlacements.length; leftIndex += 1) {
    const left = sortedPlacements[leftIndex];
    if (!left?.identity) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < sortedPlacements.length; rightIndex += 1) {
      const right = sortedPlacements[rightIndex];
      if (!right || left.serverId === right.serverId) continue;
      if (areAutomaticallyGrouped(left, right, input.allPlacements)) continue;
      input.addSuggestion(toLocalProjectLinkIdentity(left.identity), [left, right]);
    }
  }
}

function compareProjectLinkSuggestions(
  left: ProjectLinkSuggestion,
  right: ProjectLinkSuggestion,
): number {
  const repository = left.identity.repository.localeCompare(right.identity.repository);
  if (repository !== 0) return repository;
  return left.identity.subdirectory.localeCompare(right.identity.subdirectory);
}

function areAutomaticallyGrouped(
  left: ProjectLinkPlacement,
  right: ProjectLinkPlacement,
  allPlacements: readonly ProjectLinkPlacement[],
): boolean {
  const projectKey = left.projectKey;
  if (!projectKey || right.projectKey !== projectKey) return false;
  const leftCount = allPlacements.filter(
    (placement) => placement.serverId === left.serverId && placement.projectKey === projectKey,
  ).length;
  const rightCount = allPlacements.filter(
    (placement) => placement.serverId === right.serverId && placement.projectKey === projectKey,
  ).length;
  return leftCount === 1 && rightCount === 1;
}

/**
 * Local links override automatic projectKey grouping. If their latest cached Git facts no
 * longer prove the snapshot identity, every member is blocked from automatic grouping so a
 * stale local link can never silently regroup a project. An unhydrated host has no authoritative
 * Git facts yet, so defer its link override until hydration finishes.
 */
export function buildProjectLinkGroupingOverrides(input: {
  placements: Iterable<ProjectLinkPlacement>;
  links: Iterable<LocalProjectLink>;
  unhydratedServerIds?: Iterable<string>;
}): Map<string, ProjectLinkGroupingOverride> {
  const placementsByKey = new Map<string, ProjectLinkPlacement>();
  for (const placement of input.placements) {
    placementsByKey.set(projectLinkPlacementKey(placement), placement);
  }

  const overrides = new Map<string, ProjectLinkGroupingOverride>();
  const claimedMembers = new Set<string>();
  const unhydratedServerIds = new Set(input.unhydratedServerIds ?? []);
  for (const link of input.links) {
    if (link.members.some((member) => unhydratedServerIds.has(member.serverId))) {
      continue;
    }
    const memberKeys = link.members.map(projectLinkPlacementKey);
    for (const memberKey of memberKeys) {
      if (!overrides.has(memberKey)) overrides.set(memberKey, { kind: "blocked" });
    }

    if (
      !isValidLocalProjectLink(link, placementsByKey) ||
      memberKeys.some((key) => claimedMembers.has(key))
    ) {
      continue;
    }

    for (const memberKey of memberKeys) {
      overrides.set(memberKey, { kind: "linked", linkId: link.id });
      claimedMembers.add(memberKey);
    }
  }

  return overrides;
}

export function findLocalProjectLink(
  links: Iterable<LocalProjectLink>,
  placement: ProjectLinkPlacementRef,
): LocalProjectLink | null {
  const key = projectLinkPlacementKey(placement);
  for (const link of links) {
    if (link.members.some((member) => projectLinkPlacementKey(member) === key)) return link;
  }
  return null;
}

export function isValidLocalProjectLink(
  link: LocalProjectLink,
  placementsByKey: ReadonlyMap<string, ProjectLinkPlacement>,
): boolean {
  if (link.members.length < 2) return false;
  const serverIds = new Set<string>();
  const members = new Set<string>();
  for (const member of link.members) {
    const memberKey = projectLinkPlacementKey(member);
    if (members.has(memberKey) || serverIds.has(member.serverId)) return false;
    members.add(memberKey);
    serverIds.add(member.serverId);

    const placement = placementsByKey.get(memberKey);
    if (!placement?.identity || !sameLocalProjectLinkIdentity(link.identity, placement.identity)) {
      return false;
    }
  }
  return true;
}

function projectLinkIdentityKey(identity: LocalProjectLinkIdentity): string {
  return JSON.stringify([canonicalProjectRepository(identity.repository), identity.subdirectory]);
}

/**
 * Canonicalize known cloud SSH aliases to their web host. SSH ports describe a transport
 * endpoint, not a repository identity; self-hosted HTTP(S) ports remain part of the identity.
 */
function projectRepositoryAuthority(remote: GitRemoteLocation): string {
  const cloudHost = canonicalCloudHost(remote.host);
  const host = cloudHost ?? remote.host;
  const port =
    cloudHost || remote.transport === "ssh" || remote.transport === "scp" ? undefined : remote.port;
  return port ? `${host}:${port}` : host;
}

/** Normalize persisted pre-canonicalization cloud identities before comparing them. */
function canonicalProjectRepository(repository: string): string {
  const [authority, ...pathSegments] = repository.split("/");
  const host = authority?.match(/^([^:]+)(?::\d+)?$/u)?.[1];
  if (!authority || !host || pathSegments.length === 0) return repository;

  const cloudHost = canonicalCloudHost(host);
  if (!cloudHost) return repository;

  const path = pathSegments.join("/");
  return `${cloudHost}/${isGitHubHost(normalizeHost(host)) ? path.toLowerCase() : path}`;
}

function canonicalCloudHost(host: string): string | null {
  const normalizedHost = normalizeHost(host);
  for (const definition of FORGE_DEFINITIONS) {
    const cloudHosts = definition.cloudHosts?.map(normalizeHost) ?? [];
    const primaryHost = cloudHosts[0];
    if (primaryHost && cloudHosts.includes(normalizedHost)) return primaryHost;
  }
  return null;
}

function compareProjectLinkPlacements(
  left: ProjectLinkPlacement,
  right: ProjectLinkPlacement,
): number {
  return (
    left.serverName.localeCompare(right.serverName, undefined, { sensitivity: "base" }) ||
    left.serverId.localeCompare(right.serverId) ||
    left.projectName.localeCompare(right.projectName, undefined, { sensitivity: "base" }) ||
    left.projectId.localeCompare(right.projectId)
  );
}

function relativeProjectPath(rootPath: string, projectPath: string): string | null {
  const compareAsWindows = looksLikeWindowsPath(rootPath) || looksLikeWindowsPath(projectPath);
  const root = normalizePathSegments(rootPath, compareAsWindows);
  const project = normalizePathSegments(projectPath, compareAsWindows);
  if (
    !root ||
    !project ||
    root.root !== project.root ||
    root.segments.length > project.segments.length
  ) {
    return null;
  }
  const rootComparison = compareAsWindows
    ? root.segments.map((segment) => segment.toLowerCase())
    : root.segments;
  const projectComparison = compareAsWindows
    ? project.segments.map((segment) => segment.toLowerCase())
    : project.segments;
  for (let index = 0; index < root.segments.length; index += 1) {
    if (rootComparison[index] !== projectComparison[index]) return null;
  }
  return project.segments.slice(root.segments.length).join("/");
}

function normalizePathSegments(
  input: string,
  compareAsWindows: boolean,
): { root: string; segments: string[] } | null {
  let value = input.trim().replaceAll("\\", "/");
  if (!value) return null;
  value = value.replace(/^\/\/\?\/UNC\//iu, "//").replace(/^\/\/\?\//u, "");

  let root: string;
  if (compareAsWindows) {
    const drive = value.match(/^([a-zA-Z]:)(?:\/|$)/u);
    const unc = value.match(/^\/\/([^/]+)\/([^/]+)(?:\/|$)/u);
    if (drive) {
      root = drive[1]!.toLowerCase();
      value = value.slice(drive[0].length);
    } else if (unc) {
      root = `//${unc[1]!.toLowerCase()}/${unc[2]!.toLowerCase()}`;
      value = value.slice(unc[0].length);
    } else if (value.startsWith("/")) {
      root = "/";
      value = value.slice(1);
    } else {
      return null;
    }
  } else if (value.startsWith("/")) {
    root = "/";
    value = value.slice(1);
  } else {
    return null;
  }

  const segments: string[] = [];
  for (const rawSegment of value.split("/")) {
    if (!rawSegment || rawSegment === ".") continue;
    if (rawSegment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(rawSegment);
  }
  return { root, segments };
}

function looksLikeWindowsPath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/u.test(value) || /^[/\\]{2}/u.test(value);
}
