import {
  test,
  verifyProviderSettings,
  verifyNewWorkspaceModelIcon,
  verifyCompactModelIcon,
  verifyExistingAgentModelIcon,
} from "../support/helpers/plugin-provider-icons";

test("plugin provider icons follow the model through settings and wide and compact composers", async ({
  providerIcons,
}) => {
  await verifyProviderSettings(providerIcons);
  await verifyNewWorkspaceModelIcon(providerIcons);
  await verifyCompactModelIcon(providerIcons);
  await verifyExistingAgentModelIcon(providerIcons);
});
