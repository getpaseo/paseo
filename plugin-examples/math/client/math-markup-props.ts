export interface MathMarkupProps {
  /** KaTeX MathML markup on web. Always null on native, where nothing typesets. */
  markup: string | null;
  /** The delimited source, rendered when `markup` is null. */
  source: string;
  display: boolean;
  color: string;
}
