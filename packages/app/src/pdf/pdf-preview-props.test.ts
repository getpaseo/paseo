import { describe, expect, it } from "vitest";
import { parentDirectoryUri } from "./pdf-preview-props";

describe("parentDirectoryUri", () => {
  it("returns the containing directory of a staged file", () => {
    expect(parentDirectoryUri("file:///var/app/paseo-native-attachments/abc.pdf")).toBe(
      "file:///var/app/paseo-native-attachments/",
    );
  });

  it("leaves a value with no path separator alone rather than emptying the grant", () => {
    expect(parentDirectoryUri("abc.pdf")).toBe("abc.pdf");
  });
});
