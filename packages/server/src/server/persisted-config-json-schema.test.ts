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
  expect(validate(config), JSON.stringify(validate.errors)).toBe(true);
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
