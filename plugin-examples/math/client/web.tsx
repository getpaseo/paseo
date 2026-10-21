import { useMemo, type ComponentType, type CSSProperties } from "react";
import { Platform } from "react-native";
import type { MathMarkupProps } from "./math-markup-props";

/**
 * Web-only markup rendering.
 *
 * The plugin compiler bundles one client bundle for every platform and does not
 * apply Metro's `.web.tsx` resolution, so DOM rendering lives behind a runtime
 * gate here instead of a platform file extension.
 */

const INLINE_LAYOUT: CSSProperties = {
  display: "inline-block",
  maxWidth: "100%",
  verticalAlign: "baseline",
};

const BLOCK_LAYOUT: CSSProperties = {
  display: "block",
  maxWidth: "100%",
  margin: "0.4em 0",
};

interface MathSpanProps {
  dangerouslySetInnerHTML: { __html: string };
  style: CSSProperties;
}

// React DOM renders a string tag as an element. This plugin typechecks without
// the DOM library, so the tag is typed as a component instead of an intrinsic.
const MathSpan = "span" as unknown as ComponentType<MathSpanProps>;

export function WebMathMarkup({ markup, display, color }: MathMarkupProps) {
  const style = useMemo(
    () => ({ ...(display ? BLOCK_LAYOUT : INLINE_LAYOUT), color }),
    [color, display],
  );
  const html = useMemo(() => (markup === null ? null : { __html: markup }), [markup]);
  if (Platform.OS !== "web" || html === null) return null;
  return <MathSpan dangerouslySetInnerHTML={html} style={style} />;
}
