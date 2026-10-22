import { test, expect } from "../support/fixtures";
import { openSettings } from "../support/helpers/app";
import { expectAppRoute } from "../support/helpers/route-assertions";
import {
  buildPairingLink,
  cancelHostConfirmation,
  connectToConfirmedHost,
  expectHostConfirmationFor,
  expectHostInHostPicker,
  hostConfirmation,
  openPairingLink,
  saveLinkedHostBeforeLoad,
  type LinkedHost,
} from "../support/helpers/host-confirmation";

// An unreachable relay: the link saves the host without connecting first.
const linkedHost: LinkedHost = {
  serverId: "srv_link_confirmation",
  relayEndpoint: "127.0.0.1:59998",
  daemonPublicKeyB64: "bGlua0NvbmZpcm1hdGlvbktleQ",
};

test("a pairing link for a new host asks before saving it", async ({ page }) => {
  const link = buildPairingLink(linkedHost);

  await test.step("Cancel saves nothing and stays on the page", async () => {
    await openPairingLink(page, link);
    await expectHostConfirmationFor(page, linkedHost);
    await cancelHostConfirmation(page);
    await expectAppRoute(page, "/settings/general");
    await expectHostInHostPicker(page, linkedHost.serverId, "not listed");
  });

  await test.step("Connect saves the host and opens a project", async () => {
    await openPairingLink(page, link);
    await expectHostConfirmationFor(page, linkedHost);
    await connectToConfirmedHost(page);
    await expectAppRoute(page, "/open-project");
    await openSettings(page);
    await expectHostInHostPicker(page, linkedHost.serverId, "listed");
  });
});

test("a pairing link for a saved host connects without asking", async ({ page }) => {
  await saveLinkedHostBeforeLoad(page, linkedHost);

  await openPairingLink(page, buildPairingLink(linkedHost));

  await expectAppRoute(page, "/open-project", { timeout: 30_000 });
  await expect(hostConfirmation(page)).toHaveCount(0);
});
