import { describe, expect, it } from "vitest";

const BUILDS = {
  // Metro resolves src; Node consumers resolve one of the compiled builds.
  src: "react-native-svg/src/lib/extract/extractTransform.ts",
  esm: "react-native-svg/lib/module/lib/extract/extractTransform",
  cjs: "react-native-svg/lib/commonjs/lib/extract/extractTransform.js",
} as const;

const CSS_MODULE = "react-native-svg/src/css/index.tsx";
const XML_MODULE = "react-native-svg/src/xml.tsx";

type Extractor = (props: { transform?: unknown }) => unknown;
type XmlMiddleware = (root: unknown) => unknown;
interface ParsedRoot {
  props: Record<string, unknown>;
}
type XmlParser = (source: string, middleware?: XmlMiddleware) => ParsedRoot | null;

async function loadBuild(extractSpecifier: string) {
  const [cssModule, extractModule, xmlModule] = (await Promise.all([
    import(/* @vite-ignore */ CSS_MODULE),
    import(/* @vite-ignore */ extractSpecifier),
    import(/* @vite-ignore */ XML_MODULE),
  ])) as [
    { inlineStyles?: XmlMiddleware; default?: { inlineStyles?: XmlMiddleware } },
    {
      extractTransformSvgView?: Extractor;
      default?: { extractTransformSvgView?: Extractor };
    },
    { parse?: XmlParser; default?: { parse?: XmlParser } },
  ];
  const inlineStyles = cssModule.inlineStyles ?? cssModule.default?.inlineStyles;
  const extract =
    extractModule.extractTransformSvgView ?? extractModule.default?.extractTransformSvgView;
  const parseXml = xmlModule.parse ?? xmlModule.default?.parse;
  if (!inlineStyles || !extract || !parseXml)
    throw new Error(`could not load react-native-svg build`);

  return (xml: string) => {
    const root = parseXml(xml, inlineStyles);
    if (!root) throw new Error(`could not parse root SVG`);
    const props = { ...root.props };
    const style = props.style;
    if (style && typeof style === "object" && "transform" in style) {
      props.transform = style.transform;
    }
    return extract(props);
  };
}

describe.each(Object.entries(BUILDS))("root SVG transforms (%s build)", (_name, specifier) => {
  it("still converts a real SVG transform string", async () => {
    const extractFromXml = await loadBuild(specifier);

    expect(extractFromXml(`<svg transform="rotate(-90)"></svg>`)).toEqual([{ rotate: "-90deg" }]);
  });

  it.each([
    ["an inline CSS keyword", `<svg style="transform:none"></svg>`],
    ["an embedded CSS rule", `<svg><style>svg { transform: none; }</style></svg>`],
    ["a CSS angle unit", `<svg transform="rotate(-90deg)"></svg>`],
    ["a CSS length unit", `<svg transform="translate(10px, 0)"></svg>`],
  ])("drops %s from parsed root SVG props", async (_label, xml) => {
    const extractFromXml = await loadBuild(specifier);

    expect(() => extractFromXml(xml)).not.toThrow();
    expect(extractFromXml(xml)).toBeUndefined();
  });
});
