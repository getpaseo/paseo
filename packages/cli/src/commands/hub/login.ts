import type { Command } from "commander";
import { withOutput, type OutputSchema, type SingleResult } from "../../output/index.js";
import { addJsonOption } from "../../utils/command-options.js";
import type { HubCredentialStore } from "./credentials.js";
import type { CliLoginFlow } from "./login-flow.js";
import { normalizeHubOrigin } from "./origin.js";

interface HubLoginResult {
  origin: string;
  status: "logged_in";
}

const schema: OutputSchema<HubLoginResult> = {
  idField: "origin",
  columns: [
    { header: "HUB", field: "origin" },
    { header: "STATUS", field: "status" },
  ],
};

interface HubLoginDependencies {
  credentials: HubCredentialStore;
  flow: Pick<CliLoginFlow, "authorize">;
}

export async function runHubLogin(
  originInput: string,
  dependencies: HubLoginDependencies,
): Promise<SingleResult<HubLoginResult>> {
  const origin = normalizeHubOrigin(originInput);
  const credential = await dependencies.flow.authorize(origin);
  dependencies.credentials.save({ origin, credential });
  return { type: "single", data: { origin, status: "logged_in" }, schema };
}

export function addHubLoginCommand(parent: Command, dependencies: HubLoginDependencies): void {
  addJsonOption(
    parent
      .command("login")
      .description("Log in to a Paseo Hub for CLI access")
      .argument("<origin>"),
  ).action(
    withOutput(async (...args) => {
      const origin = args[0] as string;
      return runHubLogin(origin, dependencies);
    }),
  );
}
