import { expect, test } from "vitest";

import { allProviders, getAskModeConfig, getFullAccessConfig } from "./agent-configs.js";

test("Senpi has direct app-server E2E modes", () => {
  expect(allProviders).toContain("senpi");
  expect(getFullAccessConfig("senpi")).toEqual({
    provider: "senpi",
    modeId: "full-access",
  });
  expect(getAskModeConfig("senpi")).toEqual({
    provider: "senpi",
    modeId: "auto",
  });
});
