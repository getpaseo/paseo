import React, { type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkspaceOrganizationModeContent } from "./sidebar-organization-mode-content";

const EMPTY_SECTIONS = [] as const;
const HIDDEN_PROJECT_RECOVERY = React.createElement(
  "div",
  { "data-testid": "hidden-project-recovery" },
  "Hidden projects",
);

function renderEmptySections(): ReactElement {
  return React.createElement("span", { hidden: true });
}

describe("WorkspaceOrganizationModeContent", () => {
  it.each([
    ["none", false],
    ["workspace label", true],
  ])("keeps hidden-project recovery visible in %s mode", (_mode, showGroupedHeaders) => {
    const markup = renderToStaticMarkup(
      <WorkspaceOrganizationModeContent
        headerSections={EMPTY_SECTIONS}
        groupedSections={EMPTY_SECTIONS}
        organizationFooter={HIDDEN_PROJECT_RECOVERY}
        renderSections={renderEmptySections}
        showGroupedHeaders={showGroupedHeaders}
      />,
    );

    expect(markup).toContain('data-testid="hidden-project-recovery"');
  });
});
