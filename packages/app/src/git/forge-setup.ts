import type { TFunction } from "i18next";
import type { ForgeAuthState } from "@getpaseo/protocol/messages";
import type { ForgeSetupSurface } from "@getpaseo/protocol/forge-manifest";
import type { ClientForgeHostSnapshot } from "@/git/client-forge-registry";
import { buildForgeSignInCommand, getForgePresentation, type Forge } from "@/git/forge";

// The precise setup step a workspace needs before its forge features work, or
// null when nothing is actionable (authenticated, or no forge remote at all).
export type ForgeSetupAction = "install_cli" | "sign_in" | null;

// Drive the onboarding callout from the forge's auth state so the message names
// the exact next step (install the CLI vs sign in) for whichever forge backs the
// workspace — GitHub included. GitLab additionally requires the host to advertise
// GitLab support, matching the rest of the GitLab UI.
export function computeForgeSetupAction(input: {
  forge: Forge;
  forgeProvidersSupported: boolean;
  authState: ForgeAuthState | undefined;
}): ForgeSetupAction {
  // A daemon without pluggable forge support can't operate any non-GitHub forge,
  // so don't offer a setup action for one it can't drive.
  if (input.forge !== "github" && !input.forgeProvidersSupported) {
    return null;
  }
  switch (input.authState) {
    case "cli_missing":
      return "install_cli";
    case "unauthenticated":
      return "sign_in";
    case "authenticated":
    case "no_remote":
    case "error":
      return null;
    default:
      return null;
  }
}

export interface ForgeSetupGuidance {
  message: string;
  /** Settings screen to open, when the forge has one instead of a CLI. */
  setup: ForgeSetupSurface | null;
}

export function buildForgeSetupGuidance(input: {
  action: ForgeSetupAction;
  forge: Forge;
  host: string | null;
  clientForgeHost: ClientForgeHostSnapshot;
  t: TFunction;
}): ForgeSetupGuidance | null {
  if (!input.action) {
    return null;
  }
  const { brandLabel, signInCli, setup } = getForgePresentation(input.forge, input.clientForgeHost);
  if (signInCli === null) {
    // A token-authenticated forge has nothing to install and no command to run,
    // so point at the screen that takes the token instead of telling the user to
    // "set up" the forge somewhere unspecified.
    if (setup) {
      return {
        message: input.t("workspace.git.forgeSetup.openSettings", { brand: brandLabel }),
        setup,
      };
    }
    // An unknown or third-party forge rendered neutrally: neither a CLI nor a
    // settings screen to name.
    return {
      message: input.t("workspace.git.forgeSetup.generic", { brand: brandLabel }),
      setup: null,
    };
  }
  if (input.action === "install_cli") {
    return {
      message: input.t("workspace.git.forgeSetup.installCli", {
        cli: signInCli,
        brand: brandLabel,
      }),
      setup: null,
    };
  }
  const command = buildForgeSignInCommand(input.forge, input.host, input.clientForgeHost);
  return {
    message: input.t("workspace.git.forgeSetup.signIn", { command, brand: brandLabel }),
    setup: null,
  };
}
