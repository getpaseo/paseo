import { describe, expect, it } from "vitest";
import type { PluginForgeClientProviderContribution } from "@getpaseo/plugin";
import { ClientForgeRegistry } from "./client-forge-registry";
import { buildForgeSetupGuidance, computeForgeSetupAction } from "./forge-setup";

// Renders the key and its interpolations so a test asserts which message was
// chosen rather than a translated string.
const t = ((key: string, values?: Record<string, unknown>) =>
  `${key}:${JSON.stringify(values ?? {})}`) as never;

function hostWith(overrides: Partial<PluginForgeClientProviderContribution>) {
  const registry = new ClientForgeRegistry();
  registry.replaceHost("host", [
    {
      pluginId: "acme-plugin",
      contribution: {
        definition: {
          id: "acme",
          displayName: "Acme",
          changeRequestAbbrev: "PR",
          changeRequestNoun: "pull request",
          changeRequestNumberPrefix: "#",
          issueNumberPrefix: "#",
          signIn: null,
          cloudHosts: ["forge.example.com"],
        },
        ...overrides,
      },
    },
  ]);
  return registry.getHostSnapshot("host");
}

describe("buildForgeSetupGuidance", () => {
  it("points a token-authenticated forge at the plugin screen that takes the token", () => {
    const guidance = buildForgeSetupGuidance({
      action: "sign_in",
      forge: "acme",
      host: "forge.example.com",
      clientForgeHost: hostWith({ setup: { screenId: "credentials" } }),
      t,
    });

    expect(guidance?.message).toContain("workspace.git.forgeSetup.openSettings");
    expect(guidance?.setup).toEqual({ pluginId: "acme-plugin", screenId: "credentials" });
  });

  it("attributes the screen to the plugin that registered the provider", () => {
    const registry = new ClientForgeRegistry();
    registry.replaceHost("host", [
      {
        pluginId: "owning-plugin",
        contribution: {
          definition: {
            id: "acme",
            displayName: "Acme",
            changeRequestAbbrev: "PR",
            changeRequestNoun: "pull request",
            changeRequestNumberPrefix: "#",
            issueNumberPrefix: "#",
            signIn: null,
          },
          setup: { screenId: "credentials" },
        },
      },
    ]);

    const guidance = buildForgeSetupGuidance({
      action: "sign_in",
      forge: "acme",
      host: null,
      clientForgeHost: registry.getHostSnapshot("host"),
      t,
    });

    expect(guidance?.setup?.pluginId).toBe("owning-plugin");
  });

  it("falls back to neutral guidance when the forge names neither a CLI nor a screen", () => {
    const guidance = buildForgeSetupGuidance({
      action: "sign_in",
      forge: "acme",
      host: null,
      clientForgeHost: hostWith({}),
      t,
    });

    expect(guidance?.message).toContain("workspace.git.forgeSetup.generic");
    expect(guidance?.setup).toBeNull();
  });

  it("keeps the CLI wording when the forge has one, even alongside a screen", () => {
    const registry = new ClientForgeRegistry();
    registry.replaceHost("host", [
      {
        pluginId: "acme-plugin",
        contribution: {
          definition: {
            id: "acme",
            displayName: "Acme",
            changeRequestAbbrev: "PR",
            changeRequestNoun: "pull request",
            changeRequestNumberPrefix: "#",
            issueNumberPrefix: "#",
            signIn: { cli: "acme", command: "acme auth login" },
          },
          setup: { screenId: "credentials" },
        },
      },
    ]);

    const install = buildForgeSetupGuidance({
      action: "install_cli",
      forge: "acme",
      host: null,
      clientForgeHost: registry.getHostSnapshot("host"),
      t,
    });
    const signIn = buildForgeSetupGuidance({
      action: "sign_in",
      forge: "acme",
      host: null,
      clientForgeHost: registry.getHostSnapshot("host"),
      t,
    });

    expect(install?.message).toContain("workspace.git.forgeSetup.installCli");
    expect(install?.setup).toBeNull();
    expect(signIn?.message).toContain("workspace.git.forgeSetup.signIn");
    expect(signIn?.setup).toBeNull();
  });

  it("returns nothing when there is no actionable setup step", () => {
    expect(
      buildForgeSetupGuidance({
        action: null,
        forge: "acme",
        host: null,
        clientForgeHost: hostWith({ setup: { screenId: "credentials" } }),
        t,
      }),
    ).toBeNull();
  });
});

describe("computeForgeSetupAction", () => {
  it("maps auth state onto the next step", () => {
    const base = { forge: "acme" as const, forgeProvidersSupported: true };

    expect(computeForgeSetupAction({ ...base, authState: "cli_missing" })).toBe("install_cli");
    expect(computeForgeSetupAction({ ...base, authState: "unauthenticated" })).toBe("sign_in");
    expect(computeForgeSetupAction({ ...base, authState: "authenticated" })).toBeNull();
    expect(computeForgeSetupAction({ ...base, authState: undefined })).toBeNull();
  });

  it("offers nothing for a plugin forge the daemon cannot drive", () => {
    expect(
      computeForgeSetupAction({
        forge: "acme",
        forgeProvidersSupported: false,
        authState: "unauthenticated",
      }),
    ).toBeNull();
  });
});
