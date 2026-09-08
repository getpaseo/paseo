import {
  test,
  openRequirementHost,
  expectAppMismatch,
  correctRequirementAndReload,
  rejectDaemonMismatch,
} from "../support/helpers/plugin-requirements";

test("shows which runtime is incompatible and recovers after the requirement is corrected", async ({
  page,
  requirementHost,
}) => {
  await openRequirementHost(page, requirementHost);
  await expectAppMismatch(page);
  await correctRequirementAndReload(page, requirementHost.directory);
  await rejectDaemonMismatch(page, requirementHost.directory);
  await correctRequirementAndReload(page, requirementHost.directory);
});
