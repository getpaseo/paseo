import {
  test,
  verifyProviderSettings,
  verifyNewWorkspaceModelIcon,
  verifyCompactModelIcon,
  verifyExistingAgentModelIcon,
  verifyProviderIconOverrides,
} from "../support/helpers/plugin-provider-icons";

test("plugin provider icons follow the model through settings and wide and compact composers", async ({
  providerIcons,
}) => {
  await verifyProviderSettings(providerIcons);
  await verifyNewWorkspaceModelIcon(providerIcons);
  await verifyCompactModelIcon(providerIcons);
  await verifyExistingAgentModelIcon(providerIcons);
});

test("client icon overrides replace built-in and custom providers and recover on removal", async ({
  providerIcons,
}) => {
  await verifyProviderIconOverrides(providerIcons);
});
