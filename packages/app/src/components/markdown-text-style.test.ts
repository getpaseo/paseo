import { describe, expect, it } from "vitest";
import { StyleSheet, type TextStyle } from "react-native";
import { resolvePlainMarkdownTextStyle } from "@/components/markdown-text-style";

function unistylesStyle(id: string, style: Record<string, unknown>) {
  return {
    ...style,
    [`unistyles_${id}`]: { id },
  };
}

function uiTextViewFlatten(rootStyle: TextStyle, style: TextStyle): Record<string, unknown> {
  // react-native-uitextview/src/util.ts:8 flattens [rootStyle, style]
  // before passing the result to its native View-backed components.
  return { ...(StyleSheet.flatten([rootStyle, style]) as Record<string, unknown>) };
}

function unistylesMetadataKeys(style: Record<string, unknown>) {
  return Object.keys(style).filter((key) => key.startsWith("unistyles_"));
}

describe("resolvePlainMarkdownTextStyle", () => {
  it("keeps UITextView from collapsing parent and child Unistyles styles into one native View style object", () => {
    const merged = uiTextViewFlatten(
      resolvePlainMarkdownTextStyle(unistylesStyle("paragraph", { color: "#111" })),
      resolvePlainMarkdownTextStyle(unistylesStyle("text", { fontWeight: "600" })),
    );

    expect(unistylesMetadataKeys(merged)).toHaveLength(0);
    expect(merged).toMatchObject({ color: "#111", fontWeight: "600" });
  });
});
