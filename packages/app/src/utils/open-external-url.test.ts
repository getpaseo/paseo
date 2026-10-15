import { describe, expect, it } from "vitest";
import { openExternalUrl } from "./open-external-url";

describe("external URL refusal", () => {
  it.each(["mailto:person@example.com", "javascript:alert(1)", "/relative", "invalid"])(
    "safely ignores %s for fire-and-forget callers",
    async (url) => {
      await expect(openExternalUrl(url)).resolves.toBeUndefined();
    },
  );
});
