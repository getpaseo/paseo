import { expect, test } from "../support/fixtures";
import { getServerId } from "../support/helpers/server-id";
import { openNewWorkspacePromptDeepLink } from "../support/helpers/new-workspace";

test("a new-workspace deep link preserves query context and prefills its prompt", async ({
  page,
}) => {
  const serverId = getServerId();
  const name = "TEst";
  const prompt = "Fix auth & add # regression coverage\nThen run the focused tests.";

  await openNewWorkspacePromptDeepLink(page, { serverId, name, prompt });
  await expect(page.getByRole("textbox", { name: "Message agent..." })).toHaveValue(prompt, {
    timeout: 30_000,
  });
});
