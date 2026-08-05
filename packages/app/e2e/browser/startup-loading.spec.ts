import { test } from "../support/fixtures";
import { startupScenario } from "../support/helpers/startup-dsl";

test.describe("Startup loading presentation", () => {
  test("mobile reconnect preserves the saved host shell", async ({ page }) => {
    const startup = await startupScenario(page)
      .withMobileViewport()
      .withSavedHost({
        serverId: "srv_unreachable_mobile",
        label: "Dev",
        endpoint: "127.0.0.1:45678",
      })
      .openRoot();

    await startup.expectsSavedHostShell({ serverId: "srv_unreachable_mobile", label: "Dev" });
    await startup.expectsNoSavedHostErrorStatus();
    await startup.expectsNoLocalServerStartupCopy();
  });
});
