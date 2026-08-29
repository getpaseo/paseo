import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import {
  findLocalProjectLink,
  projectLinkPlacementKey,
  sameLocalProjectLinkIdentity,
  type LocalProjectLink,
  type LocalProjectLinkIdentity,
  type ProjectLinkPlacementRef,
} from "./local-project-links";

const LOCAL_PROJECT_LINKS_STORAGE_KEY = "local-project-links";

const ProjectLinkPlacementRefSchema = z.strictObject({
  serverId: z.string().trim().min(1),
  projectId: z.string().trim().min(1),
});

const LocalProjectLinkIdentitySchema = z.strictObject({
  repository: z.string().trim().min(1),
  subdirectory: z.string(),
});

export const LocalProjectLinksPersistedStateSchema = z.strictObject({
  links: z.array(
    z.strictObject({
      id: z.string().trim().min(1),
      members: z.array(ProjectLinkPlacementRefSchema).min(2),
      identity: LocalProjectLinkIdentitySchema,
    }),
  ),
});

interface LocalProjectLinksStoreState {
  links: LocalProjectLink[];
  linkProjects: (input: {
    members: ProjectLinkPlacementRef[];
    identity: LocalProjectLinkIdentity;
  }) => void;
  unlinkProject: (placement: ProjectLinkPlacementRef) => void;
}

export function createLocalProjectLinkId(): string {
  return `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function linkLocalProjects(input: {
  links: readonly LocalProjectLink[];
  members: readonly ProjectLinkPlacementRef[];
  identity: LocalProjectLinkIdentity;
  id?: string;
}): LocalProjectLink[] {
  const members = normalizeMembers(input.members);
  if (members.length < 2 || !hasDistinctServers(members)) return [...input.links];

  const overlappingLinks = input.links.filter((link) =>
    members.some((member) => findLocalProjectLink([link], member) !== null),
  );
  if (
    overlappingLinks.some((link) => !sameLocalProjectLinkIdentity(link.identity, input.identity))
  ) {
    return [...input.links];
  }

  const mergedMembers = normalizeMembers([
    ...members,
    ...overlappingLinks.flatMap((link) => link.members),
  ]);
  if (!hasDistinctServers(mergedMembers)) return [...input.links];

  return [
    ...input.links.filter((link) => !overlappingLinks.includes(link)),
    {
      // Keep the existing view key when adding another host to a link so sidebar ordering and
      // collapse state do not jump. A true group merge deterministically keeps the first link.
      id: input.id ?? overlappingLinks[0]?.id ?? createLocalProjectLinkId(),
      members: mergedMembers,
      identity: { ...input.identity },
    },
  ];
}

export function unlinkLocalProject(input: {
  links: readonly LocalProjectLink[];
  placement: ProjectLinkPlacementRef;
}): LocalProjectLink[] {
  const placementKey = projectLinkPlacementKey(input.placement);
  return input.links.flatMap((link) => {
    const members = link.members.filter(
      (member) => projectLinkPlacementKey(member) !== placementKey,
    );
    return members.length >= 2 ? [{ ...link, members }] : [];
  });
}

export const useLocalProjectLinksStore = create<LocalProjectLinksStoreState>()(
  persist(
    (set) => ({
      links: [],
      linkProjects: (input) =>
        set((state) => ({
          links: linkLocalProjects({ ...input, links: state.links }),
        })),
      unlinkProject: (placement) =>
        set((state) => ({
          links: unlinkLocalProject({ links: state.links, placement }),
        })),
    }),
    {
      name: LOCAL_PROJECT_LINKS_STORAGE_KEY,
      storage: createValidatedPersistStorage(AsyncStorage, LocalProjectLinksPersistedStateSchema),
      partialize: (state) => ({ links: state.links }),
    },
  ),
);

function normalizeMembers(members: readonly ProjectLinkPlacementRef[]): ProjectLinkPlacementRef[] {
  const seen = new Set<string>();
  const normalized: ProjectLinkPlacementRef[] = [];
  for (const member of members) {
    const serverId = member.serverId.trim();
    const projectId = member.projectId.trim();
    if (!serverId || !projectId) continue;
    const normalizedMember = { serverId, projectId };
    const key = projectLinkPlacementKey(normalizedMember);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(normalizedMember);
  }
  return normalized;
}

function hasDistinctServers(members: readonly ProjectLinkPlacementRef[]): boolean {
  return new Set(members.map((member) => member.serverId)).size === members.length;
}
