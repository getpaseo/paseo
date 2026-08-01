import { describe, expect, test } from "vitest";

import { AGENT_PROVIDER_DEFINITIONS, BUILTIN_PROVIDER_IDS } from "./provider-manifest.js";

describe("provider manifest provenance", () => {
  test("keeps the immutable built-in receipt synchronized with provider definitions", () => {
    expect(Object.isFrozen(BUILTIN_PROVIDER_IDS)).toBe(true);
    expect(AGENT_PROVIDER_DEFINITIONS.map((definition) => definition.id)).toEqual(
      BUILTIN_PROVIDER_IDS,
    );
  });
});
