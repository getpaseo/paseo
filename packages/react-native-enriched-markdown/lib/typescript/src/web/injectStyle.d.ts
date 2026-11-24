/**
 * Idempotently injects a `<style>` rule into `document.head`.
 *
 * Safe on SSR (no-op when `document` is undefined) and HMR (de-duped by `id`).
 * Intended for module-level invocation: `N` mounted components produce a
 * single `<style>` tag in the DOM.
 */
export declare const injectStyleOnce: (id: string, css: string) => void;
//# sourceMappingURL=injectStyle.d.ts.map