"use strict";

let katexLoadPromise = null;

/** Lazily loads KaTeX. Resolves to null if not installed. */
export function loadKaTeX() {
  if (!katexLoadPromise) {
    let instance = null;
    try {
      const mod = require('katex');
      const candidate = mod?.default ?? mod;
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
//# sourceMappingURL=katex.js.map