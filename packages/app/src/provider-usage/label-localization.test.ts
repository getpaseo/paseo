import { describe, expect, it } from "vitest";

import { localizeProviderUsageLabel } from "./label-localization";

const labels = {
  session: "本次会话",
  weekly: "每周",
  credits: "额度",
};

describe("localizeProviderUsageLabel", () => {
  it("localizes known quota labels supplied by providers", () => {
    expect(localizeProviderUsageLabel("Session", labels)).toBe("本次会话");
    expect(localizeProviderUsageLabel("Weekly", labels)).toBe("每周");
    expect(localizeProviderUsageLabel("Credits", labels)).toBe("额度");
  });

  it("preserves provider-defined labels", () => {
    expect(localizeProviderUsageLabel("Pro plan", labels)).toBe("Pro plan");
  });
});
