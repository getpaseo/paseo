import { describe, expect, it } from "vitest";
import type {
  PaseoAgentCatalogEntry,
  RedactedPaseoAgentProviderConfig,
} from "@getpaseo/protocol/messages";

import {
  createPaseoAgentProviderInput,
  getPaseoAgentApiKeyAuth,
  getPaseoAgentOAuthAuth,
  isPaseoAgentCatalogEntrySupported,
  nextPaseoAgentProviderName,
  parsePaseoAgentModelIds,
  paseoAgentAuthBadge,
  paseoAgentProviderLabel,
  preferredPaseoAgentOAuthMode,
} from "./paseo-agent-settings-sheet-model";

function catalogEntry(overrides: Partial<PaseoAgentCatalogEntry>): PaseoAgentCatalogEntry {
  return {
    id: "catalog-alpha",
    label: "Catalog Alpha",
    api: "responses",
    baseUrl: "https://alpha.example.test",
    auth: { kind: "api_key", envVar: "ALPHA_API_KEY" },
    models: [{ id: "alpha-fast", label: "Alpha Fast", reasoning: true }],
    ...overrides,
  };
}

function providerConfig(
  overrides: Partial<RedactedPaseoAgentProviderConfig>,
): RedactedPaseoAgentProviderConfig {
  return {
    name: "catalog-alpha",
    providerType: "catalog-alpha",
    models: [{ id: "alpha-fast" }],
    available: true,
    ...overrides,
  };
}

describe("paseo-agent-settings-sheet-model", () => {
  it("recognizes supported catalog auth manifests", () => {
    const apiKeyEntry = catalogEntry({
      auth: {
        kind: "api_key",
        envVar: "ALPHA_API_KEY",
        keyUrl: "https://alpha.example.test/key",
        placeholder: "alpha-key",
        hint: "Paste the key from Alpha",
      },
    });
    const oauthEntry = catalogEntry({
      auth: { kind: "oauth", flow: "alpha-oauth" },
    });

    expect(getPaseoAgentApiKeyAuth(apiKeyEntry)).toEqual({
      kind: "api_key",
      envVar: "ALPHA_API_KEY",
      keyUrl: "https://alpha.example.test/key",
      placeholder: "alpha-key",
      hint: "Paste the key from Alpha",
    });
    expect(getPaseoAgentOAuthAuth(oauthEntry)).toEqual({
      kind: "oauth",
      flow: "alpha-oauth",
    });
    expect(isPaseoAgentCatalogEntrySupported(apiKeyEntry)).toBe(true);
    expect(isPaseoAgentCatalogEntrySupported(oauthEntry)).toBe(true);
  });

  it("keeps unknown catalog auth kinds visible but unsupported", () => {
    const entry = catalogEntry({ auth: { kind: "future_auth", prompt: "later" } });

    expect(getPaseoAgentApiKeyAuth(entry)).toBeNull();
    expect(getPaseoAgentOAuthAuth(entry)).toBeNull();
    expect(isPaseoAgentCatalogEntrySupported(entry)).toBe(false);
  });

  it("prefers device-code OAuth only for a relay connection", () => {
    expect(preferredPaseoAgentOAuthMode({ type: "relay" })).toBe("device_code");
    expect(preferredPaseoAgentOAuthMode({ type: "directSocket" })).toBe("browser");
    expect(preferredPaseoAgentOAuthMode({ type: "directPipe" })).toBe("browser");
    expect(preferredPaseoAgentOAuthMode({ type: "directTcp" })).toBe("browser");
    expect(preferredPaseoAgentOAuthMode(null)).toBe("browser");
  });

  it("parses model ids from comma and newline separated input", () => {
    expect(
      parsePaseoAgentModelIds(`
        alpha/fast, beta/steady
        alpha/fast
        gamma/deep
      `),
    ).toEqual(["alpha/fast", "beta/steady", "gamma/deep"]);
  });

  it("uses the catalog label for the first provider instance", () => {
    expect(nextPaseoAgentProviderName(catalogEntry({ label: "Acme Cloud" }), [])).toBe(
      "Acme Cloud",
    );
  });

  it("numbers later provider instances from the catalog label", () => {
    expect(
      nextPaseoAgentProviderName(catalogEntry({ label: "Acme Cloud" }), [
        providerConfig({ name: "Acme Cloud" }),
        providerConfig({ name: "Acme Cloud (1)" }),
      ]),
    ).toBe("Acme Cloud (2)");
  });

  it("builds a generic provider payload with a trimmed explicit key", () => {
    expect(
      createPaseoAgentProviderInput({
        entry: catalogEntry({ id: "catalog-beta" }),
        name: " beta-main ",
        apiKey: " beta-secret ",
      }),
    ).toEqual({
      name: "beta-main",
      providerType: "catalog-beta",
      options: {
        apiKey: "beta-secret",
        models: [{ id: "alpha-fast", label: "Alpha Fast", reasoning: true }],
      },
    });
  });

  it("builds a generic provider payload with custom model ids", () => {
    expect(
      createPaseoAgentProviderInput({
        entry: catalogEntry({ models: [] }),
        name: "alpha-main",
        apiKey: "alpha-secret",
        modelIds: ["alpha/fast", "beta/steady"],
      }),
    ).toEqual({
      name: "alpha-main",
      providerType: "catalog-alpha",
      options: {
        apiKey: "alpha-secret",
        models: [{ id: "alpha/fast" }, { id: "beta/steady" }],
      },
    });
  });

  it("omits model overrides when the catalog has no defaults", () => {
    expect(
      createPaseoAgentProviderInput({
        entry: catalogEntry({ models: [] }),
        name: "alpha-main",
        apiKey: "alpha-secret",
      }),
    ).toEqual({
      name: "alpha-main",
      providerType: "catalog-alpha",
      options: {
        apiKey: "alpha-secret",
      },
    });
  });

  it("builds a generic provider payload with an env reference for an empty key", () => {
    expect(
      createPaseoAgentProviderInput({
        entry: catalogEntry({ auth: { kind: "api_key", envVar: "BETA_API_KEY" } }),
        name: "beta-main",
        apiKey: "  ",
      }),
    ).toEqual({
      name: "beta-main",
      providerType: "catalog-alpha",
      options: {
        apiKey: "$BETA_API_KEY",
        models: [{ id: "alpha-fast", label: "Alpha Fast", reasoning: true }],
      },
    });
  });

  it("builds an oauth provider payload without key material", () => {
    expect(
      createPaseoAgentProviderInput({
        entry: catalogEntry({ auth: { kind: "oauth", flow: "alpha-oauth" } }),
        name: "alpha-login",
      }),
    ).toEqual({
      name: "alpha-login",
      providerType: "catalog-alpha",
      options: {
        models: [{ id: "alpha-fast", label: "Alpha Fast", reasoning: true }],
      },
    });
  });

  it("uses catalog labels and generic auth badges for instance rows", () => {
    expect(paseoAgentProviderLabel(providerConfig({}), catalogEntry({}))).toBe("Catalog Alpha");
    expect(
      paseoAgentProviderLabel(providerConfig({ providerType: "custom-alpha" }), undefined),
    ).toBe("custom-alpha");
    expect(paseoAgentAuthBadge({ kind: "api_key", configured: true })).toEqual({
      label: "Connected",
      variant: "success",
    });
    expect(paseoAgentAuthBadge({ kind: "oauth", configured: false })).toEqual({
      label: "Needs attention",
      variant: "error",
    });
    expect(paseoAgentAuthBadge(undefined)).toBeNull();
  });
});
