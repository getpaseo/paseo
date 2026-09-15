import { describe, expect, it } from "vitest";

const { addAssistantProvider, assistantProviderAuthority } = require("./with-assistant-provider");

describe("withAssistantProvider", () => {
  it("uses one authority for release builds and a private one for debug", () => {
    expect(assistantProviderAuthority("sh.paseo")).toBe("sh.paseo.assistant");
    expect(assistantProviderAuthority("sh.paseo.assembly")).toBe("sh.paseo.assistant");
    expect(assistantProviderAuthority("sh.paseo.debug")).toBe("sh.paseo.debug.assistant");
  });

  it("declares the exported provider on the application exactly once", () => {
    const manifest = {
      manifest: { application: [{ $: { "android:name": ".MainApplication" } }] },
    };

    const once = addAssistantProvider(manifest, "sh.paseo");
    const twice = addAssistantProvider(once, "sh.paseo");

    expect(twice.manifest.application[0].provider).toEqual([
      {
        $: {
          "android:name": "sh.paseo.androidintents.AssistantContentProvider",
          "android:authorities": "sh.paseo.assistant",
          "android:exported": "true",
          "android:grantUriPermissions": "false",
        },
      },
    ]);
  });
});
