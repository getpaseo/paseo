import { readFileSync } from "node:fs";
import Ajv from "ajv";
import { expect, test } from "vitest";
import { z } from "zod";

import { PersistedConfigSchema } from "./persisted-config.js";

const publishedSchema = JSON.parse(
  readFileSync(
    new URL("../../../website/public/schemas/paseo.config.v1.json", import.meta.url),
    "utf8",
  ),
);

test("editors accept the daemon's browser, profile, plugin and metadata configuration", () => {
  const config = {
    $schema: "https://paseo.sh/schemas/paseo.config.v1.json",
    version: 1,
    daemon: {
      browserTools: { enabled: true },
      terminalProfiles: [],
      agentProfiles: [],
    },
    pluginsEnabled: true,
    plugins: {},
    agents: {
      metadataGeneration: { providers: [{ provider: "claude", model: "claude-opus-5" }] },
    },
  };
  expect(PersistedConfigSchema.parse(config)).toEqual(config);
  const validate = new Ajv({ allErrors: true, strict: false }).compile(publishedSchema);
  const valid = validate(config);
  expect(validate.errors).toBeNull();
  expect(valid).toBe(true);
});

test("the published schema stays current with the daemon's configuration schema", () => {
  const generated = z.toJSONSchema(PersistedConfigSchema, {
    target: "draft-07",
    unrepresentable: "any",
    io: "input",
  });
  generated.title = "PaseoConfigV1";
  expect(
    publishedSchema,
    "Run npm run generate:config-schema --workspace=@getpaseo/server",
  ).toEqual(generated);
});

test("editors retain the existing proxy configuration help", () => {
  const daemon = publishedSchema.properties.daemon.properties;
  expect(daemon.trustedProxies.description).toBe(
    'Express trusted proxy setting for X-Forwarded-* headers. Defaults to ["loopback"]. Use true only when the final trusted proxy overwrites client-supplied forwarded headers.',
  );
  expect(daemon.serviceProxy.properties.enabled.description).toBe(
    "Compatibility shim. false suppresses optional service proxy listen/public layers only; localhost proxying remains enabled.",
  );
  expect(daemon.serviceProxy.properties.listen.description).toBe(
    "Optional service-only listener address. Presence enables the standalone service proxy listener.",
  );
  expect(daemon.serviceProxy.properties.publicBaseUrl.description).toBe(
    "Optional public base URL for service host aliases.",
  );
});

test.each([
  { daemon: { browserTools: { enabled: "yes" } } },
  { daemon: { terminalProfiles: "default" } },
  { daemon: { agentProfiles: "default" } },
  { pluginsEnabled: "yes" },
  { plugins: [] },
  { agents: { metadataGeneration: { providers: [{ provider: "" }] } } },
  { unknownSetting: true },
])("editors still reject invalid configuration: %j", (config) => {
  expect(PersistedConfigSchema.safeParse(config).success).toBe(false);
  const validate = new Ajv({ allErrors: true, strict: false }).compile(publishedSchema);
  expect(validate(config)).toBe(false);
});
