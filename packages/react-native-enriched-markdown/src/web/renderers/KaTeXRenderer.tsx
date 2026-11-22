import { useMemo, type CSSProperties } from 'react';
import type { KaTeXInstance } from '../katex';

interface KaTeXRendererProps {
  content: string;
  katex: KaTeXInstance | null;
  displayMode: boolean;
  style: CSSProperties;
}

export function KaTeXRenderer({
  content,
  katex,
  displayMode,
  style,
}: KaTeXRendererProps) {
  const delimiter = displayMode ? '$$' : '$';

  const html = useMemo(() => {
    if (!katex) return null;
    return katex.renderToString(content, {
      output: 'mathml',
      displayMode,
      throwOnError: false,
      trust: false,
    });
  }, [katex, content, displayMode]);

  const displayStyle = displayMode
    ? { ...style, display: 'block' as const, whiteSpace: 'pre-wrap' as const }
    : style;

  if (!html) {
    return (
      <span role="math" aria-label={content} style={displayStyle}>
        {`${delimiter}${content}${delimiter}`}
      </span>
    );
  }

  return (
    <span
      role="math"
      aria-label={content}
      style={displayStyle}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
