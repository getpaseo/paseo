import { describe, expect, it } from "vitest";
import { hostTextStyle } from "./host-style";

describe("native fade host layout", () => {
  it("keeps paragraph, heading, list and cell geometry on the outer box", () => {
    const style = {
      marginTop: 8,
      width: "100%" as const,
      flexShrink: 1,
      alignSelf: "flex-start" as const,
      paddingHorizontal: 4,
      fontSize: 20,
      lineHeight: 26,
      backgroundColor: "gray",
    };
    expect(hostTextStyle(style)).toEqual({
      host: { marginTop: 8, width: "100%", flexShrink: 1, alignSelf: "flex-start" },
      text: { paddingHorizontal: 4, fontSize: 20, lineHeight: 26, backgroundColor: "gray" },
    });
  });
});
