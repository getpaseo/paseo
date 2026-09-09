import type { Page } from "@playwright/test";
import { test, expect } from "../support/helpers/model-visibility-fixture";
import {
  openNewWorkspaceComposer,
  submitNewWorkspacePrompt,
  expectNewWorkspaceDraft,
} from "../support/helpers/new-workspace";
import { gotoWorkspace } from "../support/helpers/launcher";
import {
  profilePickerRow,
  openModelPicker,
  expectComposerModel,
} from "../support/helpers/agent-profiles";
import {
  PROVIDER,
  HIDDEN_MODEL,
  REMAINING_MODEL,
  pickerViewport,
  selectDefaultModel,
  hideDefaultModel,
  expectHiddenModelRestorable,
  expectHiddenModelAbsent,
  expectHiddenModelAbsentFromSearch,
  expectFreshVisibleDefault,
  expectHiddenModelAfterReload,
  restoreDefaultModel,
} from "../support/helpers/model-visibility";

test.use({ catalogProvider: PROVIDER });

test("hiding a model removes it from selectors and restoring brings it back", async ({
  page,
  modelWorkspace: workspace,
}) => {
  await selectDefaultModel(page, workspace);
  await hideDefaultModel(page);
  await expectHiddenModelRestorable(page);
  await expectHiddenModelAbsent(page);
  await expectHiddenModelAbsentFromSearch(page);
  await expectFreshVisibleDefault(page);
  await expectHiddenModelAfterReload(page, workspace);
  await restoreDefaultModel(page);
});

for (const recovery of ["restore", "profile"] as const) {
  test(`hide-all rejects without side effects and clears the error after ${recovery}`, async ({
    page,
    modelWorkspace: workspace,
    catalogClient,
  }) => {
    await catalogClient.patchDaemonConfig({
      providers: {
        [PROVIDER.id]: {
          modelVisibility: { [HIDDEN_MODEL.id]: false, [REMAINING_MODEL.id]: false },
        },
      },
      agentProfiles: [
        {
          id: "hidden-profile",
          name: "Saved hidden model",
          provider: PROVIDER.id,
          model: HIDDEN_MODEL.id,
        },
      ],
    });
    await gotoWorkspace(page, workspace.workspaceId);
    await openNewWorkspaceComposer(page, workspace);
    const beforeWorkspaces = (await workspace.client.fetchWorkspaces()).entries;
    const beforeAgents = (await workspace.client.fetchAgents()).entries;
    await submitNewWorkspacePrompt(page, "Keep this prompt while I fix the selection");
    const error = page.getByTestId("new-workspace-submit-error");
    await expect(error).toHaveText(
      "Every model for this provider is hidden. Show one in provider settings.",
    );
    await expectNewWorkspaceDraft(page, "Keep this prompt while I fix the selection");
    expect((await workspace.client.fetchWorkspaces()).entries).toEqual(beforeWorkspaces);
    expect((await workspace.client.fetchAgents()).entries).toEqual(beforeAgents);
    await recoverSelection[recovery](page, catalogClient);
    await expectComposerModel(page, HIDDEN_MODEL.label);
    await expect(error).toHaveCount(0);
    await expectNewWorkspaceDraft(page, "Keep this prompt while I fix the selection");
    expect((await workspace.client.fetchWorkspaces()).entries).toEqual(beforeWorkspaces);
    expect((await workspace.client.fetchAgents()).entries).toEqual(beforeAgents);
  });
}

const recoverSelection = {
  restore: async (
    _page: Page,
    client: import("@getpaseo/client/internal/daemon-client").DaemonClient,
  ) => {
    await client.patchDaemonConfig({
      providers: { [PROVIDER.id]: { modelVisibility: { [HIDDEN_MODEL.id]: true } } },
    });
  },
  profile: async (page: Page) => {
    await openModelPicker(page);
    await expect(pickerViewport(page).getByTestId(`model-provider-${PROVIDER.id}`)).toBeVisible();
    await profilePickerRow(page, "Saved hidden model").click();
    await expect(pickerViewport(page)).toHaveCount(0);
  },
};
