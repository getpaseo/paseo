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
  reopenPairingLinkWithSavedHosts,
  type LinkedHost,
} from "../support/helpers/host-confirmation";

// An unreachable relay: the link saves the host without connecting first.
const linkedHost: LinkedHost = {
  serverId: "srv_link_confirmation",
  relayEndpoint: "127.0.0.1:59998",
  daemonPublicKeyB64: "bGlua0NvbmZpcm1hdGlvbktleQ",
};

test("a pairing link asks before saving a host and reconnects without asking again", async ({
  page,
}) => {
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

  await test.step("reopening the saved host link connects without asking", async () => {
    await reopenPairingLinkWithSavedHosts(page, link);
    await expectAppRoute(page, "/open-project", { timeout: 30_000 });
    await expect(hostConfirmation(page)).toHaveCount(0);
  });
});
