import {
  test,
  searchIssues,
  expectCanceledWithoutNotification,
  verifyAttachmentWhilePending,
  verifyRankingAndRemoval,
  verifyFailureAndLegacySources,
} from "../support/helpers/plugin-attachment-selection";

test.describe.configure({ timeout: 120_000 });
test.use({ viewport: { width: 1100, height: 800 } });

test.describe("desktop attachment selection", () => {
  test("notifies additions without blocking the draft; Escape cancels search", async ({
    page,
    attachments,
  }) => {
    await searchIssues(attachments);
    await page.keyboard.press("Escape");
    await expectCanceledWithoutNotification(attachments);
    await verifyAttachmentWhilePending(attachments);
    await verifyRankingAndRemoval(attachments);
    await verifyFailureAndLegacySources(attachments);
  });
});

test.describe("compact attachment selection", () => {
  test("notifies additions without blocking the draft; backdrop cancels search", async ({
    page,
    attachments,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await searchIssues(attachments);
    await page
      .getByRole("button", { name: "Bottom sheet backdrop", exact: true })
      .last()
      .click({ position: { x: 10, y: 10 } });
    await expectCanceledWithoutNotification(attachments);
    await verifyAttachmentWhilePending(attachments);
    await verifyRankingAndRemoval(attachments);
    await verifyFailureAndLegacySources(attachments);
  });
});
