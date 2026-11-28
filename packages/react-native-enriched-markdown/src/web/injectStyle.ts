/// <reference lib="dom" />

/**
 * Idempotently injects a `<style>` rule into `document.head`.
 *
 * Safe on SSR (no-op when `document` is undefined) and HMR (de-duped by `id`).
 * Intended for module-level invocation: `N` mounted components produce a
 * single `<style>` tag in the DOM.
 */
export const injectStyleOnce = (id: string, css: string): void => {
  if (typeof document === 'undefined') return;
  if (document.getElementById(id) != null) return;
  const style = document.createElement('style');
  style.id = id;
  style.textContent = css;
  document.head.appendChild(style);
};
