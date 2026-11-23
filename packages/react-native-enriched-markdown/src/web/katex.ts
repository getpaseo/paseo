export interface KaTeXInstance {
  renderToString(
    expression: string,
    options?: {
      displayMode?: boolean;
      throwOnError?: boolean;
      trust?: boolean;
      output?: 'html' | 'mathml' | 'htmlAndMathml';
    }
  ): string;
}

let katexLoadPromise: Promise<KaTeXInstance | null> | null = null;

/** Lazily loads KaTeX. Resolves to null if not installed. */
export function loadKaTeX(): Promise<KaTeXInstance | null> {
  if (!katexLoadPromise) {
    let instance: KaTeXInstance | null = null;
    try {
      const mod = require('katex');
      const candidate = (mod?.default ?? mod) as KaTeXInstance | null;
      if (typeof candidate?.renderToString === 'function') {
        instance = candidate;
      }
    } catch {
      // katex not installed — math rendering will be skipped
    }
    katexLoadPromise = Promise.resolve(instance);
  }
  return katexLoadPromise;
}
