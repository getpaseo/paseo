import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { ProjectLinksSheet } from "@/components/project-links-sheet";
import { useProjects } from "@/hooks/use-projects";
import {
  projectLinkPlacementKey,
  scopeProjectLinks,
  type ProjectLinkPlacementRef,
} from "@/projects/local-project-links";
import { useLocalProjectLinksStore } from "@/projects/local-project-links-store";

const OpenProjectLinksContext = createContext<
  ((members: readonly ProjectLinkPlacementRef[]) => void) | null
>(null);

export function useOpenSidebarProjectLinks() {
  return useContext(OpenProjectLinksContext);
}

export function useSidebarProjectLinks(members: readonly ProjectLinkPlacementRef[]) {
  const { projectLinkPlacements, projectLinkSuggestions } = useProjects({
    enabled: members.length > 0,
  });
  const links = useLocalProjectLinksStore((state) => state.links);
  const memberKeys = new Set(members.map(projectLinkPlacementKey));
  return {
    placements: projectLinkPlacements ?? [],
    ...scopeProjectLinks({ suggestions: projectLinkSuggestions, links }, (placement) =>
      memberKeys.has(projectLinkPlacementKey(placement)),
    ),
  };
}

export function SidebarProjectLinksProvider({ children }: { children: ReactNode }) {
  const [members, setMembers] = useState<readonly ProjectLinkPlacementRef[] | null>(null);
  const close = useCallback(() => setMembers(null), []);
  // The menu and its project row can unmount when linking regroups projects.
  // Keep the sheet alive at the list boundary and scope it by the captured host project IDs.
  return (
    <OpenProjectLinksContext.Provider value={setMembers}>
      {children}
      {members ? <SidebarProjectLinksDialog members={members} onClose={close} /> : null}
    </OpenProjectLinksContext.Provider>
  );
}

function SidebarProjectLinksDialog({
  members,
  onClose,
}: {
  members: readonly ProjectLinkPlacementRef[];
  onClose: () => void;
}) {
  const { placements, suggestions, links } = useSidebarProjectLinks(members);
  return (
    <ProjectLinksSheet
      visible
      onClose={onClose}
      placements={placements}
      suggestions={suggestions}
      links={links}
    />
  );
}
