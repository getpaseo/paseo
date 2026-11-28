import { describe, expect, it } from "vitest";
import { parseMermaidRuntimeRenderMessage } from "./messages";

const render = {
  type: "render",
  revision: 1,
  source: "flowchart LR\nA --> B",
  colorScheme: "dark",
  interactive: false,
};

describe("Mermaid runtime render message", () => {
  it("accepts bounded palette colours and preserves the default", () => {
    expect(parseMermaidRuntimeRenderMessage(render)).toMatchObject(render);
    const colors = {
      primaryColor: "#123abc",
      primaryTextColor: "#fff",
      secondaryColor: "#abc",
      tertiaryBorderColor: "#123456",
      lineColor: "#abc",
      textColor: "#111",
      clusterBkg: "#222",
      clusterBorder: "#333",
      edgeLabelBackground: "#444",
      titleColor: "#555",
    };
    expect(parseMermaidRuntimeRenderMessage({ ...render, style: { colors } })).toMatchObject({
      style: { colors },
    });
    expect(
      parseMermaidRuntimeRenderMessage({ ...render, style: { colors: { lineColor: undefined } } }),
    ).not.toBeNull();
  });

  it("accepts layout, type, and shape options", () => {
    const style = {
      radius: 0,
      strokeWidth: 8,
      fontFamily: "Inter, sans-serif",
      fontSize: 32,
      look: "neo",
      curve: "linear",
      nodeSpacing: 0,
      rankSpacing: 240,
      padding: 80,
      diagramPadding: 0,
      defaultShape: "diamond",
    };
    expect(parseMermaidRuntimeRenderMessage({ ...render, style })).toMatchObject({ style });
  });

  it("rejects CSS values, unknown keys, and out-of-range options", () => {
    expect(
      parseMermaidRuntimeRenderMessage({
        ...render,
        style: { colors: { lineColor: "url(https://x)" } },
      }),
    ).toBeNull();
    expect(parseMermaidRuntimeRenderMessage({ ...render, style: { themeCSS: "red" } })).toBeNull();
    expect(
      parseMermaidRuntimeRenderMessage({ ...render, style: { fontFamily: "foo(bar)" } }),
    ).toBeNull();
    expect(
      parseMermaidRuntimeRenderMessage({ ...render, style: { fontFamily: "url(https://x)" } }),
    ).toBeNull();
    expect(
      parseMermaidRuntimeRenderMessage({ ...render, style: { defaultShape: "trapezoid" } }),
    ).toBeNull();
    expect(parseMermaidRuntimeRenderMessage({ ...render, style: { curve: "spline" } })).toBeNull();
    expect(parseMermaidRuntimeRenderMessage({ ...render, style: { look: "sketch" } })).toBeNull();
    expect(parseMermaidRuntimeRenderMessage({ ...render, style: { radius: 41 } })).toBeNull();
    expect(parseMermaidRuntimeRenderMessage({ ...render, style: { radius: 1.5 } })).toBeNull();
    expect(parseMermaidRuntimeRenderMessage({ ...render, style: { fontSize: 7 } })).toBeNull();
    expect(
      parseMermaidRuntimeRenderMessage({
        ...render,
        style: { colors: { background: "#fff" } },
      }),
    ).toBeNull();
    expect(
      parseMermaidRuntimeRenderMessage({
        ...render,
        style: { frame: { backgroundColor: "#fff" } },
      }),
    ).toBeNull();
  });
});
