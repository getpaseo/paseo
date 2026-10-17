import { describe, expect, it } from "vitest";
import { parseProviderComposerControls } from "./provider.js";

describe("provider composer controls", () => {
  it("parses action, toggle, and select descriptors", () => {
    expect(
      parseProviderComposerControls([
        { kind: "action", id: "send-pony", label: "Send pony", icon: "sparkles" },
        { kind: "toggle", id: "verbose", label: "Verbose", value: true },
        {
          kind: "select",
          id: "tier",
          label: "Tier",
          value: "flex",
          options: [
            { label: "Flex", value: "flex" },
            { label: "Priority", value: "priority", icon: "zap" },
          ],
        },
      ]),
    ).toHaveLength(3);
  });

  it("rejects unknown kinds, empty options, and missing values", () => {
    expect(() =>
      parseProviderComposerControls([{ kind: "slider", id: "x", label: "X" }]),
    ).toThrow();
    expect(() =>
      parseProviderComposerControls([{ kind: "toggle", id: "x", label: "X" }]),
    ).toThrow();
    expect(() =>
      parseProviderComposerControls([
        { kind: "select", id: "x", label: "X", value: null, options: [] },
      ]),
    ).toThrow();
  });

  it("defaults to an empty control set", () => {
    expect(parseProviderComposerControls(undefined)).toEqual([]);
  });
});
