import { zoomedFontSize } from "@/text-zoom/model";

/** The line-number column at the Appearance code size; it scales with the text. */
const GUTTER_WIDTH = 56;

export interface SourceLineMetrics {
  fontSize: number;
  /** Every row is one line this tall, which getItemLayout relies on. */
  lineHeight: number;
  gutterWidth: number;
}

/** The native source view's row metrics at a text zoom. */
export function sourceLineMetrics(codeFontSize: number, zoom: number): SourceLineMetrics {
  const fontSize = zoomedFontSize(codeFontSize, zoom);
  return {
    fontSize,
    lineHeight: Math.round(fontSize * 1.45),
    gutterWidth: Math.round((GUTTER_WIDTH * fontSize) / codeFontSize),
  };
}
