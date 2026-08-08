import type { Command } from "commander";
import { withOutput, type OutputSchema, type SingleResult } from "../../output/index.js";
import { addJsonOption } from "../../utils/command-options.js";
import type { HubCredentialStore } from "./credentials.js";
import type { CliLoginFlow } from "./login-flow.js";
import { resolveHubOrigin } from "./authority.js";
import { reportHubProgress, type HubReporter } from "./reporter.js";
import { addHubResolutionHelp } from "./help.js";

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
  env: Readonly<Record<string, string | undefined>>;
  credentials: HubCredentialStore;
  flow: Pick<CliLoginFlow, "authorize">;
  reporter: HubReporter;
}

export async function runHubLogin(
  originInput: string | undefined,
  options: { json?: boolean },
  dependencies: HubLoginDependencies,
): Promise<SingleResult<HubLoginResult>> {
  const origin = resolveHubOrigin({
    options: { origin: originInput },
    env: dependencies.env,
    credentials: dependencies.credentials,
  });
  reportHubProgress(dependencies.reporter, options, `Logging in to ${origin}`);
  const credential = await dependencies.flow.authorize(origin);
  dependencies.credentials.save({ origin, credential });
  return { type: "single", data: { origin, status: "logged_in" }, schema };
}

export function addHubLoginCommand(parent: Command, dependencies: HubLoginDependencies): void {
  addJsonOption(
    addHubResolutionHelp(
      parent
        .command("login")
        .description("Log in to a Paseo Hub for CLI access")
        .argument("[origin]", "Paseo Hub origin"),
    ),
  ).action(
    withOutput(async (...args) => {
      const origin = args[0] as string | undefined;
      const options = args.at(-2) as { json?: boolean };
      return runHubLogin(origin, options, dependencies);
    }),
  );
}
