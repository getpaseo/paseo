import React, { type ReactElement } from "react";
import type { SidebarWorkspaceSectionModel } from "./sidebar-workspace-sections";

interface WorkspaceOrganizationModeContentProps {
  headerSections: readonly SidebarWorkspaceSectionModel[];
  groupedSections: readonly SidebarWorkspaceSectionModel[];
  organizationFooter: ReactElement | null;
  renderSections: (
    sections: readonly SidebarWorkspaceSectionModel[],
    showHeaders?: boolean,
  ) => ReactElement;
  showGroupedHeaders: boolean;
  listFooterComponent?: ReactElement | null;
}

export function WorkspaceOrganizationModeContent({
  headerSections,
  groupedSections,
  organizationFooter,
  renderSections,
  showGroupedHeaders,
  listFooterComponent,
}: WorkspaceOrganizationModeContentProps): ReactElement {
  return (
    <>
      {renderSections(headerSections)}
      {renderSections(groupedSections, showGroupedHeaders)}
      {organizationFooter}
      {listFooterComponent}
    </>
  );
}
