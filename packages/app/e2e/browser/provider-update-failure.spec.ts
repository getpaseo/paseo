import {
  expectNoUpdateFailure,
  openProviderInstallation,
  refreshFromOtherClient,
  refreshProviderDetails,
  runFailingUpdate,
  test,
} from "../support/helpers/provider-update-failure";

test("a refresh clears a failed update from the open Installation section", async ({
  providerUpdateFailure: { page, otherClient },
}) => {
  await openProviderInstallation(page);

  await test.step("Refresh in this view clears the failure", async () => {
    await runFailingUpdate(page);
    await refreshProviderDetails(page);
    await expectNoUpdateFailure(page);
  });

  await test.step("a refresh from another client clears it too", async () => {
    await runFailingUpdate(page);
    await refreshFromOtherClient(otherClient);
    await expectNoUpdateFailure(page);
  });
});
