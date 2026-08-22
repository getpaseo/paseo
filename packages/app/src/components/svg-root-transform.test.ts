import { describe, expect, it } from "vitest";

/**
 * A root `<Svg>` is a real React Native view, so react-native-svg rewrites a *string*
 * `transform` into RN's style syntax via `extractTransformSvgView`. That parser's grammar only
 * accepts SVG transform functions and throws a `SyntaxError` on anything else — `none`,
 * `rotate(-90deg)`, any CSS value. Upstream let the error escape, so a single unrecognised
 * string crashed the whole app during render:
 *
 *   SyntaxError: Expected transform functions but "n" found.
 *
 * We render untrusted SVG through this path: the daemon ships a project's own `favicon.svg` /
 * `icon.svg` / `logo.svg` (packages/server/src/utils/project-icon.ts) to the client, and
 * `ProjectIconImage` hands it to `SvgCss`, which inlines `<style>` rules onto the root `<svg>`.
 * `patches/react-native-svg+15.15.3.patch` makes the extractor degrade to "no transform", the
 * same way every other extractor in that file already handles a bad parse.
 *
 * These assertions pin the patch. If it is dropped — or a dependency bump lands without
 * re-applying it — the string cases throw again and this fails.
 */

const MODULES = {
  // Metro's entry for this package is `src/index.ts`, so this is the copy the iOS bundle uses.
  src: "react-native-svg/src/lib/extract/extractTransform.ts",
  esm: "react-native-svg/lib/module/lib/extract/extractTransform",
  cjs: "react-native-svg/lib/commonjs/lib/extract/extractTransform.js",
} as const;

type Extractor = (props: { transform?: unknown }) => unknown;

async function loadExtractor(specifier: string): Promise<Extractor> {
  const loaded = (await import(/* @vite-ignore */ specifier)) as {
    extractTransformSvgView?: Extractor;
    default?: { extractTransformSvgView?: Extractor };
  };
  const extractor = loaded.extractTransformSvgView ?? loaded.default?.extractTransformSvgView;
  if (!extractor) throw new Error(`no extractTransformSvgView export in ${specifier}`);
  return extractor;
}

describe.each(Object.entries(MODULES))("extractTransformSvgView (%s build)", (_name, specifier) => {
  it("passes a React Native style transform through untouched", async () => {
    const extract = await loadExtractor(specifier);
    const transform = [{ rotate: "-90deg" }];

    expect(extract({ transform })).toEqual(transform);
  });

  it("still converts a real SVG transform string", async () => {
    const extract = await loadExtractor(specifier);

    expect(extract({ transform: "rotate(-90)" })).toEqual([{ rotate: "-90deg" }]);
  });

  it.each([
    ["none", "none"],
    ["a CSS angle unit", "rotate(-90deg)"],
    ["a CSS length unit", "translate(10px, 0)"],
    ["an empty string", ""],
    ["arbitrary text", "not-a-transform"],
  ])("drops %s instead of throwing", async (_label, transform) => {
    const extract = await loadExtractor(specifier);

    expect(() => extract({ transform })).not.toThrow();
    expect(extract({ transform })).toBeUndefined();
  });
});
