import {
  backToProviderList,
  expectNoUpdateFailure,
  expectRowReadsVersionAndModels,
  expectRowReportsUpdateFailure,
  openProviderInstallation,
  refreshFromOtherClient,
  refreshProviderDetails,
  runFailingUpdate,
  test,
} from "../support/helpers/provider-update-failure";

test("a refresh clears a failed update from the provider's page and its row", async ({
  providerUpdateFailure: { page, otherClient },
}) => {
  await openProviderInstallation(page);

  await test.step("Refresh on the page clears the failure", async () => {
    await runFailingUpdate(page);
    await refreshProviderDetails(page);
    await expectNoUpdateFailure(page);
  });

  await test.step("the row in the list reads the version and models again", async () => {
    await backToProviderList(page);
    await expectRowReadsVersionAndModels(page);
  });

  await test.step("a refresh from another client clears the page", async () => {
    await openProviderInstallation(page);
    await runFailingUpdate(page);
    await refreshFromOtherClient(otherClient);
    await expectNoUpdateFailure(page);
  });

  await test.step("a refresh from another client clears the row on the open list", async () => {
    await runFailingUpdate(page);
    await backToProviderList(page);
    // Without a refresh, the row still reports the failure.
    await expectRowReportsUpdateFailure(page);
    await refreshFromOtherClient(otherClient);
    await expectRowReadsVersionAndModels(page);
  });
});
