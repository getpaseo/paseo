import { test } from "../support/helpers/model-visibility-fixture";
import { submitNewWorkspacePrompt } from "../support/helpers/new-workspace";
import {
  PROVIDER,
  RECOVERY_PROMPT,
  selectDefaultModel,
  hideDefaultModel,
  expectHiddenModelRestorable,
  expectHiddenModelAbsent,
  expectHiddenModelAbsentFromSearch,
  expectFreshVisibleDefault,
  expectHiddenModelAfterReload,
  restoreDefaultModel,
  toggleAllModels,
  openHiddenModelsDraft,
  expectHiddenModelsRejected,
  recoverHiddenModelSelection,
  expectHiddenModelsRecovered,
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
  await toggleAllModels(page);
});

for (const recovery of ["restore", "profile"] as const) {
  test(`hide-all rejects without side effects and clears the error after ${recovery}`, async ({
    page,
    modelWorkspace: workspace,
    catalogClient,
  }) => {
    const draft = await openHiddenModelsDraft({ page, workspace, catalogClient });
    await submitNewWorkspacePrompt(page, RECOVERY_PROMPT);
    await expectHiddenModelsRejected(draft);
    await recoverHiddenModelSelection({ page, catalogClient, recovery });
    await expectHiddenModelsRecovered(draft);
  });
}
