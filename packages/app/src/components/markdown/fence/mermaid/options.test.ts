import { describe, expect, it } from "vitest";
import { fitContentSize } from "@/components/zoomable-viewport/geometry";
import { mergeMermaidOptions, mermaidFrameStyle, runtimeStyleOf } from "./options";
import { getDiagramFit } from "./presentation";
describe("Mermaid option merging", () => {
  it("lets mermaid.colors win per key and keeps the other colour", () => {
    expect(
      mergeMermaidOptions(
        { primaryColor: "#111111", lineColor: "#222222" },
        { look: "neo", colors: { lineColor: "#333333" } },
      ),
    ).toEqual({
      look: "neo",
      colors: { primaryColor: "#111111", lineColor: "#333333" },
    });
  });

  it("returns undefined when nothing is set", () => {
    expect(mergeMermaidOptions(undefined, undefined)).toBeUndefined();
  });

  it("omits the frame from the sandbox style and keeps a zero radius", () => {
    expect(
      runtimeStyleOf({
        radius: 0,
        frame: { backgroundColor: "#ffffff", borderRadius: 8 },
      }),
    ).toEqual({ radius: 0 });
    expect(runtimeStyleOf({ frame: { padding: 4 } })).toBeUndefined();
  });
});

describe("Mermaid preview frame", () => {
  it("applies a validated frame and adds a hairline border", () => {
    expect(
      mermaidFrameStyle({
        backgroundColor: "#f7f8fa",
        borderColor: "#123456",
        borderRadius: 12,
        padding: 48,
      }),
    ).toEqual({
      backgroundColor: "#f7f8fa",
      borderColor: "#123456",
      borderWidth: 1,
      borderRadius: 12,
      padding: 48,
    });
  });

  it("drops the whole frame when any field is invalid", () => {
    expect(mermaidFrameStyle({ backgroundColor: "red", padding: 8 })).toEqual({});
    expect(mermaidFrameStyle({ borderColor: "url(https://x)", borderRadius: 4 })).toEqual({});
    expect(mermaidFrameStyle({ backgroundColor: "#fff", borderRadius: 41 })).toEqual({});
    expect(mermaidFrameStyle({ padding: 49 })).toEqual({});
    expect(mermaidFrameStyle({ backgroundColor: "#fff", themeCSS: "x" })).toEqual({});
  });

  it("passes frame padding into viewport fit so web diagrams inset by padding", () => {
    const textStyle = { backgroundColor: "#111111", padding: 12, borderRadius: 8 };
    expect(getDiagramFit(textStyle, undefined)).toEqual({ padding: 12 });

    const paddedFit = getDiagramFit(textStyle, { padding: 32 });
    expect(paddedFit).toEqual({ padding: 32 });
    expect(
      fitContentSize({ width: 400, height: 200 }, { width: 400, height: 200 }, paddedFit),
    ).toEqual({ width: 272, height: 136 });

    const zeroFit = getDiagramFit(textStyle, { padding: 0 });
    expect(zeroFit).toEqual({ padding: 0 });
    expect(
      fitContentSize({ width: 400, height: 200 }, { width: 400, height: 200 }, zeroFit),
    ).toEqual({ width: 400, height: 200 });
  });
});
